import { createSession, sessionCookie } from '../../../../lib/auth.js';
import { json, serverError } from '../../../../lib/http.js';
import {
    CHALLENGE_AUTHENTICATION,
    consumeChallenge,
    findCredentialById,
    recordCredentialUse
} from '../../../../lib/passkeys.js';
import { base64urlToBytes, CeremonyError, relyingParty, verifyAssertion } from '../../../../lib/webauthn.js';

// Every failure below returns exactly this, with a 401.
//
// Unknown credential, disabled account, bad signature, stale challenge, wrong
// origin — all one message. Telling them apart tells an attacker which
// credentials exist and which accounts are real, which is the one thing this
// endpoint must not do. The specific reason goes to console.warn, where it is
// useful, and nowhere else.
const SIGNIN_FAILED = 'Could not sign in with that passkey';

function refuse(reason) {
    console.warn('Passkey sign-in refused:', reason);
    return json({ error: SIGNIN_FAILED }, 401);
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let body;
    try {
        body = await request.json();
    } catch (e) {
        // A malformed body is a bad request, not a server fault. Parsing it
        // inside the outer try would report it as a 500 and put it in the error
        // log next to things that actually need looking at.
        return refuse('body was not valid JSON');
    }

    try {
        const rp = relyingParty(request);

        // Consume the challenge BEFORE verifying anything about the assertion.
        //
        // Verifying first and burning the challenge only on success reads as
        // the considerate thing to do, and it means a captured assertion can be
        // replayed as often as you like for the challenge's whole lifetime,
        // because a failed attempt leaves the challenge exactly as it was. The
        // atomic UPDATE inside consumeChallenge is what makes two simultaneous
        // replays resolve to one winner.
        let consumed;
        try {
            consumed = await consumeChallenge(env, body.challenge, CHALLENGE_AUTHENTICATION);
        } catch (e) {
            return refuse(e instanceof CeremonyError ? e.message : e);
        }

        const credentialId = String(body.credentialId || '');
        if (!credentialId) return refuse('no credential id presented');

        // Looked up by credential id rather than by the assertion's userHandle:
        // credential_id is UNIQUE across all users, so it identifies the
        // account on its own, and it is the field the signature actually
        // covers by way of the authenticator's own bookkeeping.
        const credential = await findCredentialById(env, credentialId);
        if (!credential) return refuse(`unknown credential ${credentialId}`);

        const admin = await env.DB.prepare(
            'SELECT id, disabled_at FROM AdminUsers WHERE id = ?'
        ).bind(credential.user_id).first();

        if (!admin) return refuse('credential belongs to no account');
        if (admin.disabled_at) return refuse(`account ${admin.id} is disabled`);

        let result;
        try {
            result = await verifyAssertion({
                clientDataJSON: base64urlToBytes(body.clientDataJSON),
                authenticatorData: base64urlToBytes(body.authenticatorData),
                signature: base64urlToBytes(body.signature),
                storedPublicKeySpki: base64urlToBytes(credential.public_key),
                algorithm: credential.algorithm,
                expectedChallenge: consumed.challenge,
                relyingParty: rp
            });
        } catch (e) {
            return refuse(e instanceof CeremonyError ? e.message : e);
        }

        // Recorded, not enforced. See the note at the end of verifyAssertion.
        await recordCredentialUse(env, credentialId, result.signCount);

        const session = await createSession(env, admin.id);

        return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(session.id) });
    } catch (e) {
        console.error('POST /api/dashboard/passkeys/signin-verify failed:', e);
        return serverError('Server error');
    }
}
