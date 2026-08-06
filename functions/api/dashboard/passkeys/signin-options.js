import { json, serverError } from '../../../../lib/http.js';
import { CHALLENGE_AUTHENTICATION, issueChallenge } from '../../../../lib/passkeys.js';
import { relyingParty } from '../../../../lib/webauthn.js';

// Sign-in options. Deliberately unauthenticated — it is the start of signing in.
//
// Note what this response does NOT contain: any indication of which credentials
// exist, or whether the account has any at all. It is byte-for-byte the same
// shape whether the dashboard has three passkeys enrolled or none, so it
// enumerates nothing. That falls out of using discoverable credentials rather
// than being a check somebody has to remember.
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const rp = relyingParty(request);

        // No user id: with a discoverable credential the browser's own picker
        // decides which account is signing in, so at this point the server does
        // not know who is at the keyboard — and must not ask, because asking is
        // a username box and a username box is an account oracle.
        const challenge = await issueChallenge(env, CHALLENGE_AUTHENTICATION, null);

        return json({
            challenge,
            rpId: rp.id,

            // Empty, and that is the point. Naming the enrolled credentials
            // here would both leak which ones exist and defeat the picker; the
            // credential itself knows which account it belongs to, and the
            // server reads that out of the assertion afterwards.
            allowCredentials: [],

            // Requested here, checked against the returned flags in
            // verifyAssertion — an authenticator may ignore the request.
            userVerification: 'required',
            timeout: 60000
        });
    } catch (e) {
        console.error('POST /api/dashboard/passkeys/signin-options failed:', e);
        return serverError('Could not start passkey sign-in');
    }
}
