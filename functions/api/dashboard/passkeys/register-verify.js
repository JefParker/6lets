import { requireAdminSession } from '../../../../lib/auth.js';
import { badRequest, json, serverError, unauthorized } from '../../../../lib/http.js';
import {
    CHALLENGE_REGISTRATION,
    consumeChallenge,
    findCredentialById,
    insertCredential
} from '../../../../lib/passkeys.js';
import { base64urlToBytes, CeremonyError, relyingParty, verifyRegistration } from '../../../../lib/webauthn.js';

const MAX_NICKNAME_LENGTH = 40;

// Same rule /api/user applies to display names: no control characters, no angle
// brackets. The management list renders with textContent, so this is a second
// layer rather than the only one.
//
// Written as an explicit scan rather than a character class because the obvious
// regex for "control characters and brackets" is a range, and a range is easy
// to get subtly wrong in a way that still looks like a validator: a class of
// space-through-'<' rejects every name containing a space or a digit, so
// "Pixel 8" fails with a message about angle brackets.
function hasInvalidNicknameChars(value) {
    for (const ch of value) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) return true; // C0 controls and DEL
        if (ch === '<' || ch === '>') return true;
    }
    return false;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const session = await requireAdminSession(request, env);
    if (!session) return unauthorized();

    let body;
    try {
        body = await request.json();
    } catch (e) {
        // A bad request, not a server fault — parsing inside the outer try
        // would report it as a 500.
        return badRequest('Malformed request');
    }

    try {
        const rp = relyingParty(request);

        const nickname = String(body.nickname || '').trim();
        if (!nickname) {
            // Required, because a management screen of three identical rows is
            // one nobody dares delete from.
            return badRequest('Give this passkey a name so you can recognise it later');
        }
        if (nickname.length > MAX_NICKNAME_LENGTH || hasInvalidNicknameChars(nickname)) {
            return badRequest(`Name must be ${MAX_NICKNAME_LENGTH} characters or fewer, with no angle brackets`);
        }

        // Consume first, verify second. A challenge that is only burned on
        // success can be retried until it expires — see consumeChallenge().
        const consumed = await consumeChallenge(env, body.challenge, CHALLENGE_REGISTRATION);

        // The challenge must have been issued to *this* session's user, not
        // merely be a valid registration challenge belonging to someone else.
        if (consumed.user_id !== session.user_id) {
            throw new CeremonyError('challenge was issued for a different user');
        }

        const verified = await verifyRegistration({
            clientDataJSON: base64urlToBytes(body.clientDataJSON),
            authenticatorData: base64urlToBytes(body.authenticatorData),
            publicKeySpki: base64urlToBytes(body.publicKey),
            algorithm: Number(body.algorithm),
            expectedChallenge: consumed.challenge,
            relyingParty: rp
        });

        const credentialId = String(body.credentialId || '');
        if (!credentialId) throw new CeremonyError('no credential id presented');

        // excludeCredentials is only a hint, so a second enrolment of the same
        // authenticator can still arrive here. Say so plainly rather than
        // letting the UNIQUE constraint surface as a 500.
        if (await findCredentialById(env, credentialId)) {
            return badRequest('That device already has a passkey for this account');
        }

        await insertCredential(env, {
            userId: session.user_id,
            credentialId,
            publicKey: body.publicKey,
            algorithm: Number(body.algorithm),
            // Recorded from the ceremony, never enforced afterwards. Taken
            // from the parsed authData rather than hardcoded to 0, so the
            // stored value means what the column name says.
            signCount: verified.signCount,
            nickname,
            transports: Array.isArray(body.transports) ? body.transports : null
        });

        return json({ success: true });
    } catch (e) {
        if (e instanceof CeremonyError) {
            // Enrolment failures can be specific: the caller is already
            // authenticated, so there is nothing here to enumerate. Sign-in is
            // the ceremony that has to stay vague.
            console.warn('Passkey registration refused:', e.message);
            return badRequest('That passkey could not be registered. Please try again.');
        }
        console.error('POST /api/dashboard/passkeys/register-verify failed:', e);
        return serverError('Could not register the passkey');
    }
}
