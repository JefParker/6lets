// WebAuthn ceremony verification, on WebCrypto only.
//
// ===========================================================================
// WHY THERE IS NO CBOR DECODER IN THIS FILE — read before "fixing" it
// ===========================================================================
//
// The usual reason a WebAuthn server pulls in a library is `attestationObject`:
// CBOR wrapping authenticator data wrapping a COSE-encoded public key. Decoding
// that by hand is ~150 lines of parser, which is why @simplewebauthn/server
// exists. This codebase never sees an attestationObject, because the browser
// will hand over the same three facts already unwrapped:
//
//   response.getPublicKey()          -> SPKI DER, which crypto.subtle
//                                       .importKey('spki', ...) accepts as-is
//   response.getPublicKeyAlgorithm() -> the COSE algorithm number
//   response.getAuthenticatorData()  -> raw authData, so the server still
//                                       checks rpIdHash and the flags itself
//
// The client sends those as base64url. No CBOR, no COSE, no parser.
//
// The objection is "then the client is telling you its own public key", and it
// does not survive being written out:
//
//   1. Registration requests attestation: "none". A none-format attestation
//      object carries no signature over its own contents. Decoding it therefore
//      authenticates nothing — a client willing to lie could put a different
//      key inside the CBOR and a dutiful server would parse it, believe it, and
//      have learned exactly nothing. Both routes trust the client equally; one
//      of them costs 150 lines of parser.
//
//   2. The most a lying client achieves is registering a credential it already
//      controls against an account it is already signed in to — enrolment
//      requires a live session, which required the password. It can do that
//      through the front door.
//
// If you ever switch to attestation: "direct" and actually verify an
// attestation certificate chain against a metadata service, this reasoning
// changes and you will need real CBOR. Nothing else changes it.
// ===========================================================================

// Ceremony failures get their own type so callers can tell "this assertion is
// bad" apart from "this code is broken". Without it, a catch block that prints
// `e.message` puts something like "response.getPublicKey is not a function" on
// the sign-in screen, where it reads to the user as something they did wrong.
export class CeremonyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CeremonyError';
    }
}

// COSE algorithm identifiers, in the order they are offered.
//
// ES256 first because it is what every modern platform authenticator produces.
// RS256 second for older Windows Hello TPM stacks, which is the only reason it
// is here. Anything else is rejected at registration rather than stored: a key
// whose algorithm we cannot verify is a credential that can never sign in, and
// discovering that at sign-in time is much worse than refusing it at enrolment.
export const ES256 = -7;
export const RS256 = -257;
export const SUPPORTED_ALGORITHMS = [ES256, RS256];

const AUTH_DATA_MIN_LENGTH = 37; // rpIdHash(32) + flags(1) + signCount(4)
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

// --------------------------------------------------------------- base64url --

export function bytesToBase64url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    // Chunked rather than String.fromCharCode(...view): spreading a large array
    // into an argument list blows the call-stack limit on big SPKI blobs.
    for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new CeremonyError('expected a base64url string');
    }
    // Reject before atob rather than after: atob on some malformed inputs
    // throws a DOMException whose message says nothing useful in a log.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new CeremonyError('value is not base64url');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function randomChallenge() {
    return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// ------------------------------------------------------ relying party identity --

// The RP ID is derived from the request, never from configuration.
//
// A passkey is bound to the origin it was created on. One enrolled on
// `localhost` will not work on the production hostname and vice versa; if the
// site also answers on *.pages.dev, that is a second, separate credential
// namespace where the passkey button appears and finds nothing. Deriving from
// the request means an assertion presented to a host it was not made for
// arrives carrying an rpIdHash that cannot match, and is refused here rather
// than silently accepted against the wrong namespace.
export function relyingParty(request) {
    const url = new URL(request.url);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    // Browsers treat localhost as a secure context over plain http, so local
    // development works; everything else must be https or the ceremony would
    // not have been allowed to run in the first place.
    if (!isLocal && url.protocol !== 'https:') {
        throw new CeremonyError(`WebAuthn requires https (got ${url.protocol}//${url.host})`);
    }

    return {
        id: url.hostname,
        // Includes the port, because the origin in clientDataJSON does.
        origin: `${url.protocol}//${url.host}`
    };
}

// ------------------------------------------------------------- authData ----

export function parseAuthenticatorData(bytes) {
    if (bytes.length < AUTH_DATA_MIN_LENGTH) {
        throw new CeremonyError(`authenticatorData is ${bytes.length} bytes, expected at least ${AUTH_DATA_MIN_LENGTH}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes[32];
    return {
        rpIdHash: bytes.subarray(0, 32),
        flags,
        userPresent: (flags & FLAG_USER_PRESENT) !== 0,
        userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
        signCount: view.getUint32(33, false) // big-endian, per spec
    };
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ---------------------------------------------------------- clientData -----

// Shared checks for both ceremonies. `expectedType` is 'webauthn.create' for
// registration and 'webauthn.get' for sign-in — a create response replayed into
// the sign-in endpoint fails here.
export function verifyClientData(clientDataJSON, { expectedType, expectedOrigin, expectedChallenge }) {
    let clientData;
    try {
        clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));
    } catch (e) {
        throw new CeremonyError('clientDataJSON is not valid JSON');
    }

    if (clientData.type !== expectedType) {
        throw new CeremonyError(`clientData.type is "${clientData.type}", expected "${expectedType}"`);
    }

    // Exact string equality. Not endsWith, not a regex, not a startsWith on the
    // scheme. Origin binding is the single property passkeys exist to provide —
    // it is what makes them unphishable — and a check that accepts
    // "sixlets.example.com.attacker.net" because it ends with the right suffix
    // gives that property away while still looking like a check.
    if (clientData.origin !== expectedOrigin) {
        throw new CeremonyError(`clientData.origin is "${clientData.origin}", expected "${expectedOrigin}"`);
    }

    // Explicitly `!== true`: the field is optional and absent means same-origin.
    if (clientData.crossOrigin === true) {
        throw new CeremonyError('ceremony was performed cross-origin');
    }

    if (clientData.challenge !== expectedChallenge) {
        throw new CeremonyError('clientData.challenge does not match the issued challenge');
    }

    return clientData;
}

// --------------------------------------------------------- signatures ------

// ⚠ THE TRAP WITH NO SYMPTOM — do not delete this function.
//
// ECDSA signatures arrive DER-wrapped. crypto.subtle.verify wants raw r‖s.
//
// Skip this conversion and verify() does not throw, does not warn, and does not
// log. It returns `false`. For every valid signature. Forever. Every other
// check in the ceremony passes, so the failure points at nothing — you get a
// sign-in that is simply always refused, with a clean server log.
//
// DER here is SEQUENCE { INTEGER r, INTEGER s }. Each integer is big-endian and
// minimally encoded, which means it carries a leading 0x00 whenever its top bit
// is set (so it is not read as negative) and drops leading zero bytes
// otherwise. P-256 wants both components at exactly 32 bytes: strip the leading
// zeros, then left-pad to 32.
//
// test/webauthn.test.mjs signs with raw r‖s and re-wraps it as DER precisely so
// that deleting this function turns the suite red. That is the only way a
// machine catches this one.
export function derToRawEcdsaSignature(der) {
    let offset = 0;

    if (der[offset++] !== 0x30) {
        throw new CeremonyError('ECDSA signature is not a DER SEQUENCE');
    }

    // Sequence length. Long-form (top bit set) says how many bytes the length
    // itself occupies; a P-256 signature is short enough that this is always
    // short-form in practice, but a malformed input must not be read as data.
    let seqLength = der[offset++];
    if (seqLength & 0x80) {
        const lengthBytes = seqLength & 0x7f;
        if (lengthBytes === 0 || lengthBytes > 2) {
            throw new CeremonyError('malformed DER sequence length');
        }
        seqLength = 0;
        for (let i = 0; i < lengthBytes; i++) seqLength = (seqLength << 8) | der[offset++];
    }
    if (offset + seqLength !== der.length) {
        throw new CeremonyError('DER sequence length does not match the signature length');
    }

    const readInteger = () => {
        if (der[offset++] !== 0x02) {
            throw new CeremonyError('expected a DER INTEGER in the ECDSA signature');
        }
        const length = der[offset++];
        if (length & 0x80) throw new CeremonyError('malformed DER integer length');

        let value = der.subarray(offset, offset + length);
        offset += length;

        // Drop the sign-padding zeros, keeping at least one byte so a genuine
        // zero component survives.
        let start = 0;
        while (start < value.length - 1 && value[start] === 0x00) start++;
        value = value.subarray(start);

        if (value.length > 32) {
            throw new CeremonyError('ECDSA signature component is too large for P-256');
        }

        // Left-pad. A 31-byte r written into the first 31 bytes instead of the
        // last 31 is a different number, and verify() would once again just
        // return false.
        const padded = new Uint8Array(32);
        padded.set(value, 32 - value.length);
        return padded;
    };

    const r = readInteger();
    const s = readInteger();
    if (offset !== der.length) {
        throw new CeremonyError('trailing bytes after the ECDSA signature');
    }

    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw;
}

export async function importCredentialPublicKey(spkiBytes, algorithm) {
    if (algorithm === ES256) {
        return crypto.subtle.importKey(
            'spki', spkiBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
        );
    }
    if (algorithm === RS256) {
        return crypto.subtle.importKey(
            'spki', spkiBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
        );
    }
    // Unreachable if registration did its job; thrown rather than assumed so a
    // row written by some future path cannot quietly verify as the wrong type.
    throw new CeremonyError(`unsupported algorithm ${algorithm}`);
}

// ------------------------------------------------------- the ceremonies ----

// Registration. Returns the fields to store; the caller owns the challenge
// lifecycle and the INSERT.
export async function verifyRegistration({
    clientDataJSON,      // Uint8Array, raw bytes as received
    authenticatorData,   // Uint8Array
    publicKeySpki,       // Uint8Array — from getPublicKey()
    algorithm,           // number     — from getPublicKeyAlgorithm()
    expectedChallenge,
    relyingParty: rp
}) {
    verifyClientData(clientDataJSON, {
        expectedType: 'webauthn.create',
        expectedOrigin: rp.origin,
        expectedChallenge
    });

    if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
        throw new CeremonyError(`algorithm ${algorithm} was not offered`);
    }

    const auth = parseAuthenticatorData(authenticatorData);

    // The authenticator hashes the RP ID it believes it is talking to. If that
    // is not us, the credential belongs to a different origin's namespace.
    if (!equalBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(rp.id)))) {
        throw new CeremonyError('rpIdHash does not match this relying party');
    }

    if (!auth.userPresent) {
        throw new CeremonyError('user-present flag is not set');
    }

    // userVerification: "required" was requested — and is checked here, because
    // the request is one an authenticator is permitted to ignore. Asking
    // without checking means a bare touch satisfies a sign-in the UI describes
    // as a fingerprint.
    if (!auth.userVerified) {
        throw new CeremonyError('user-verified flag is not set');
    }

    // Import it once now rather than trusting it at sign-in: a key that
    // importKey rejects is a credential that could never verify, and this is
    // the last moment where refusing it is a clean error message instead of a
    // locked-out admin.
    await importCredentialPublicKey(publicKeySpki, algorithm);

    return { algorithm, signCount: auth.signCount };
}

// Sign-in.
export async function verifyAssertion({
    clientDataJSON,      // Uint8Array, raw bytes as received
    authenticatorData,   // Uint8Array
    signature,           // Uint8Array — DER for ES256
    storedPublicKeySpki, // Uint8Array
    algorithm,
    expectedChallenge,
    relyingParty: rp
}) {
    verifyClientData(clientDataJSON, {
        expectedType: 'webauthn.get',
        expectedOrigin: rp.origin,
        expectedChallenge
    });

    const auth = parseAuthenticatorData(authenticatorData);

    if (!equalBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(rp.id)))) {
        throw new CeremonyError('rpIdHash does not match this relying party');
    }
    if (!auth.userPresent) {
        throw new CeremonyError('user-present flag is not set');
    }
    if (!auth.userVerified) {
        throw new CeremonyError('user-verified flag is not set');
    }

    // The signed payload is authenticatorData ‖ SHA-256(clientDataJSON), using
    // the clientDataJSON bytes exactly as they arrived.
    //
    // Do not re-serialise the parsed object to canonicalise it first. JSON.parse
    // followed by JSON.stringify reorders keys, drops insignificant whitespace
    // and re-escapes characters — any one of those changes a byte, and the hash,
    // and the signature stops matching, for reasons that take an afternoon to
    // find because the object you print looks identical.
    const clientDataHash = await sha256(clientDataJSON);
    const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
    signedData.set(authenticatorData, 0);
    signedData.set(clientDataHash, authenticatorData.length);

    const key = await importCredentialPublicKey(storedPublicKeySpki, algorithm);

    let ok;
    if (algorithm === ES256) {
        ok = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            derToRawEcdsaSignature(signature), // see the warning on that function
            signedData
        );
    } else {
        // RSASSA-PKCS1-v1_5 signatures are already raw; there is no DER
        // envelope to unwrap.
        ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signedData);
    }

    if (!ok) throw new CeremonyError('signature did not verify');

    // Returned so the caller can record it. Deliberately not compared against
    // the stored value: the spec offers the counter for clone detection, but
    // iCloud Keychain, Google Password Manager and every other syncing provider
    // return 0 forever by design — the credential is meant to be on all your
    // devices. Enforcing monotonicity locks out the common case and catches
    // nothing.
    return { signCount: auth.signCount };
}
