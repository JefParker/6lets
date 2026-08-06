import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthenticator, FLAG_UP } from './helpers/authenticator.mjs';
import { createTestAdmin, createTestDatabase, dbSkip } from './helpers/d1.mjs';

import {
    CeremonyError,
    derToRawEcdsaSignature,
    ES256,
    importCredentialPublicKey,
    relyingParty,
    verifyAssertion,
    verifyRegistration
} from '../lib/webauthn.js';

import {
    CHALLENGE_AUTHENTICATION,
    CHALLENGE_REGISTRATION,
    consumeChallenge,
    issueChallenge
} from '../lib/passkeys.js';

import { requireAdminSession } from '../lib/auth.js';

const RP = { id: 'sixlets.example.com', origin: 'https://sixlets.example.com' };

async function rejects(fn, description) {
    await assert.rejects(fn, (e) => {
        assert.ok(e instanceof CeremonyError, `expected a CeremonyError, got ${e && e.name}: ${e && e.message}`);
        return true;
    }, description);
}

describe('the ECDSA DER-to-raw conversion', () => {
    // This is the trap with no symptom, so it gets a test that fails loudly
    // rather than one that merely exercises the happy path.
    test('WebCrypto rejects the DER signature it was given, and accepts the converted one', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const assertion = await authenticator.sign({ challenge: 'abc', origin: RP.origin });

        const key = await importCredentialPublicKey(authenticator.publicKeySpki, ES256);
        const algorithm = { name: 'ECDSA', hash: 'SHA-256' };

        // Handed the DER bytes directly, crypto.subtle.verify does not throw,
        // does not warn, and returns false. That silence is the entire problem.
        const withoutConversion = await crypto.subtle.verify(
            algorithm, key, assertion.signature, assertion.signedData
        );
        assert.equal(withoutConversion, false,
            'DER passed straight to verify() should fail — if this ever passes, the conversion is no longer load-bearing and this suite has stopped protecting it');

        const withConversion = await crypto.subtle.verify(
            algorithm, key, derToRawEcdsaSignature(assertion.signature), assertion.signedData
        );
        assert.equal(withConversion, true);
    });

    test('round-trips back to the raw signature WebCrypto produced', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const assertion = await authenticator.sign({ challenge: 'abc', origin: RP.origin });

        assert.deepEqual(
            Array.from(derToRawEcdsaSignature(assertion.signature)),
            Array.from(assertion.rawSignature)
        );
    });

    test('refuses a signature that is not a DER sequence', () => {
        assert.throws(() => derToRawEcdsaSignature(Uint8Array.from([0x02, 0x01, 0x00])), CeremonyError);
    });
});

describe('sign-in', () => {
    test('a real signature signs in', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const assertion = await authenticator.sign({ challenge: 'chal-1', origin: RP.origin });

        const result = await verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-1',
            relyingParty: RP
        });

        assert.equal(result.signCount, 0);
    });

    test('an unset user-verified flag is refused', async () => {
        const authenticator = await createAuthenticator(RP.id);
        // User present but not verified: a bare touch. The ceremony asked for
        // userVerification "required", and an authenticator is free to ignore
        // the request — so the flag has to be checked, not just requested.
        const assertion = await authenticator.sign({
            challenge: 'chal-2', origin: RP.origin, flags: FLAG_UP
        });

        await rejects(() => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-2',
            relyingParty: RP
        }), 'an unverified assertion must not sign in');
    });

    test('a lookalike origin is refused', async () => {
        const authenticator = await createAuthenticator(RP.id);
        // Ends with the real origin. A check written as endsWith, or as a
        // regex missing an anchor, accepts this and hands back the one property
        // passkeys exist to provide.
        const assertion = await authenticator.sign({
            challenge: 'chal-3',
            origin: 'https://sixlets.example.com.attacker.net'
        });

        await rejects(() => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-3',
            relyingParty: RP
        }), 'a suffix-matching origin must be refused');
    });

    test('a cross-origin ceremony is refused', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const assertion = await authenticator.sign({
            challenge: 'chal-4', origin: RP.origin, crossOrigin: true
        });

        await rejects(() => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-4',
            relyingParty: RP
        }));
    });

    test('an assertion for another relying party is refused', async () => {
        const authenticator = await createAuthenticator(RP.id);
        // Same code, different host: a passkey made on localhost presented to
        // production carries an rpIdHash that cannot match.
        const assertion = await authenticator.sign({
            challenge: 'chal-5', origin: RP.origin, rpIdOverride: 'localhost'
        });

        await rejects(() => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-5',
            relyingParty: RP
        }));
    });

    test('a corrupted signature is refused', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const assertion = await authenticator.sign({ challenge: 'chal-6', origin: RP.origin });

        // Flip a bit in the final byte of s, which keeps the DER structure
        // valid — so this exercises the signature check itself rather than the
        // parser rejecting a malformed envelope.
        const tampered = Uint8Array.from(assertion.signature);
        tampered[tampered.length - 1] ^= 0x01;

        await rejects(() => verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: tampered,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-6',
            relyingParty: RP
        }));
    });

    test('a registration response cannot be redeemed as a sign-in', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const registration = await authenticator.register({ challenge: 'chal-7', origin: RP.origin });
        const assertion = await authenticator.sign({ challenge: 'chal-7', origin: RP.origin });

        // clientData.type is webauthn.create, so even with a good signature
        // over its own data the sign-in path refuses it.
        await rejects(() => verifyAssertion({
            clientDataJSON: registration.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            storedPublicKeySpki: authenticator.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'chal-7',
            relyingParty: RP
        }));
    });
});

describe('registration', () => {
    test('accepts a well-formed enrolment', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const registration = await authenticator.register({ challenge: 'reg-1', origin: RP.origin });

        const result = await verifyRegistration({
            clientDataJSON: registration.clientDataJSON,
            authenticatorData: registration.authenticatorData,
            publicKeySpki: registration.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'reg-1',
            relyingParty: RP
        });

        assert.equal(result.algorithm, ES256);
    });

    test('refuses an algorithm that was never offered', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const registration = await authenticator.register({ challenge: 'reg-2', origin: RP.origin });

        // EdDSA. Storing a key we have no path to verify turns into a
        // credential that can never sign in, discovered at the worst moment.
        await rejects(() => verifyRegistration({
            clientDataJSON: registration.clientDataJSON,
            authenticatorData: registration.authenticatorData,
            publicKeySpki: registration.publicKeySpki,
            algorithm: -8,
            expectedChallenge: 'reg-2',
            relyingParty: RP
        }));
    });

    test('refuses an unverified enrolment', async () => {
        const authenticator = await createAuthenticator(RP.id);
        const registration = await authenticator.register({
            challenge: 'reg-3', origin: RP.origin, flags: FLAG_UP
        });

        await rejects(() => verifyRegistration({
            clientDataJSON: registration.clientDataJSON,
            authenticatorData: registration.authenticatorData,
            publicKeySpki: registration.publicKeySpki,
            algorithm: ES256,
            expectedChallenge: 'reg-3',
            relyingParty: RP
        }));
    });
});

describe('relying party identity', () => {
    test('is derived from the request, and keeps the port', () => {
        const rp = relyingParty(new Request('https://sixlets.example.com:8443/api/x'));
        assert.equal(rp.id, 'sixlets.example.com');
        assert.equal(rp.origin, 'https://sixlets.example.com:8443');
    });

    test('allows localhost over http, because browsers treat it as secure', () => {
        const rp = relyingParty(new Request('http://localhost:8791/api/x'));
        assert.equal(rp.id, 'localhost');
        assert.equal(rp.origin, 'http://localhost:8791');
    });

    test('refuses plain http anywhere else', () => {
        assert.throws(() => relyingParty(new Request('http://sixlets.example.com/api/x')), CeremonyError);
    });
});

describe('challenges (single-use)', { skip: dbSkip }, () => {
    test('the same challenge cannot be consumed twice', async () => {
        const { env } = createTestDatabase();
        const challenge = await issueChallenge(env, CHALLENGE_AUTHENTICATION, null);

        const first = await consumeChallenge(env, challenge, CHALLENGE_AUTHENTICATION);
        assert.equal(first.challenge, challenge);

        // Nothing else in the system tests the anti-replay property: the
        // signature over a captured assertion stays valid forever, so refusing
        // the replay is entirely the challenge's job.
        await rejects(() => consumeChallenge(env, challenge, CHALLENGE_AUTHENTICATION),
            'a replayed challenge must be refused');
    });

    test('a captured assertion replayed verbatim is refused', async () => {
        const { env } = createTestDatabase();
        const authenticator = await createAuthenticator(RP.id);

        // One full sign-in, in the order signin-verify.js does it: consume the
        // challenge first, then verify.
        const challenge = await issueChallenge(env, CHALLENGE_AUTHENTICATION, null);
        const assertion = await authenticator.sign({ challenge, origin: RP.origin });

        const signIn = async () => {
            const consumed = await consumeChallenge(env, challenge, CHALLENGE_AUTHENTICATION);
            return verifyAssertion({
                clientDataJSON: assertion.clientDataJSON,
                authenticatorData: assertion.authenticatorData,
                signature: assertion.signature,
                storedPublicKeySpki: authenticator.publicKeySpki,
                algorithm: ES256,
                expectedChallenge: consumed.challenge,
                relyingParty: RP
            });
        };

        await signIn(); // succeeds
        await rejects(signIn, 'the identical assertion must not sign in a second time');
    });

    test('a registration challenge is not redeemable as a sign-in', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const challenge = await issueChallenge(env, CHALLENGE_REGISTRATION, userId);

        await rejects(() => consumeChallenge(env, challenge, CHALLENGE_AUTHENTICATION));

        // Still spendable for what it was issued for — the failed attempt above
        // must not have burned it.
        const consumed = await consumeChallenge(env, challenge, CHALLENGE_REGISTRATION);
        assert.equal(consumed.challenge, challenge);
    });

    test('an expired challenge is refused', async () => {
        const { env } = createTestDatabase();
        const challenge = await issueChallenge(env, CHALLENGE_AUTHENTICATION, null);

        // Six minutes later; the TTL is five.
        await rejects(() => consumeChallenge(env, challenge, CHALLENGE_AUTHENTICATION, {
            now: Date.now() + 6 * 60 * 1000
        }));
    });
});

describe('route guards', { skip: dbSkip }, () => {
    test('session-guarded routes refuse an anonymous caller', async () => {
        const { env } = createTestDatabase();
        const request = new Request('https://sixlets.example.com/api/dashboard/passkeys');

        assert.equal(await requireAdminSession(request, env), null);
    });

    test('a cookie naming no session is refused', async () => {
        const { env } = createTestDatabase();
        const request = new Request('https://sixlets.example.com/api/dashboard/passkeys', {
            headers: { Cookie: 'auth_token=not-a-real-session-id' }
        });

        assert.equal(await requireAdminSession(request, env), null);
    });
});
