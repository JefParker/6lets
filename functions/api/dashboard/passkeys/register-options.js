import { requireAdminSession } from '../../../../lib/auth.js';
import { json, serverError, unauthorized } from '../../../../lib/http.js';
import { CHALLENGE_REGISTRATION, issueChallenge, listCredentials } from '../../../../lib/passkeys.js';
import { bytesToBase64url, ES256, relyingParty, RS256 } from '../../../../lib/webauthn.js';

// Enrolment options.
//
// ⚠ This route requires an existing session, and that is not incidental. You
// add a passkey from inside the dashboard, having already signed in with the
// password. An enrol-from-nothing path — "prove it's you by registering a new
// credential" — is a way to attach a credential to an account without proving
// you hold the old one, which is the whole of account takeover in one endpoint.
export async function onRequestPost(context) {
    const { request, env } = context;

    const session = await requireAdminSession(request, env);
    if (!session) return unauthorized();

    try {
        const rp = relyingParty(request);

        const admin = await env.DB.prepare('SELECT id, username FROM AdminUsers WHERE id = ?')
            .bind(session.user_id).first();
        if (!admin) return unauthorized();

        const challenge = await issueChallenge(env, CHALLENGE_REGISTRATION, admin.id);
        const existing = await listCredentials(env, admin.id);

        return json({
            challenge,
            rp: { id: rp.id, name: '6Lets' },
            user: {
                // A byte sequence per spec; the client base64url-decodes it.
                id: bytesToBase64url(new TextEncoder().encode(admin.id)),
                name: admin.username,
                displayName: admin.username
            },

            // Offered in preference order. ES256 is what every modern platform
            // authenticator produces; RS256 is here only for older Windows
            // Hello TPM stacks. Registration refuses anything not on this list
            // rather than storing a key it has no path to verify.
            pubKeyCredParams: [
                { type: 'public-key', alg: ES256 },
                { type: 'public-key', alg: RS256 }
            ],

            authenticatorSelection: {
                // Discoverable ("resident") credential. The credential itself
                // remembers which account it belongs to, which is what removes
                // the username box from the sign-in screen — the browser's own
                // picker answers "who", and the server reads the answer out of
                // the assertion.
                residentKey: 'required',
                requireResidentKey: true,
                // Requested here, and checked again on the returned flags,
                // because an authenticator is allowed to ignore this.
                userVerification: 'required'
            },

            // No attestation is requested, and none is parsed. See the long
            // comment at the top of lib/webauthn.js before changing this — the
            // absence of a CBOR decoder in this codebase follows from it.
            attestation: 'none',

            // A hint to the authenticator that this device is already enrolled,
            // so it can say so instead of silently creating a second credential
            // that nobody can tell apart from the first on the management
            // screen. Authenticators may ignore it, which is why the UNIQUE
            // constraint on AdminCredentials.credential_id is what actually
            // holds.
            excludeCredentials: existing.map(c => ({
                type: 'public-key',
                id: c.credential_id,
                transports: c.transports ? JSON.parse(c.transports) : undefined
            })),

            timeout: 60000
        });
    } catch (e) {
        console.error('POST /api/dashboard/passkeys/register-options failed:', e);
        return serverError('Could not start passkey registration');
    }
}
