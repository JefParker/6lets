import { requireAdminSession } from '../../../../lib/auth.js';
import { json, serverError, unauthorized } from '../../../../lib/http.js';
import { deleteCredential } from '../../../../lib/passkeys.js';

// Remove one passkey.
//
// Deliberately allows removing the last one. The password is still there — that
// is the reason AdminUsers.password_hash stays NOT NULL — so deleting every
// passkey is inconvenient rather than a lockout, and a "you must keep one"
// rule would instead strand anyone whose only enrolled device was lost.
export async function onRequestDelete(context) {
    const { request, env, params } = context;

    const session = await requireAdminSession(request, env);
    if (!session) return unauthorized();

    try {
        // Scoped to the session's own user inside the DELETE, so a valid
        // session cannot remove another admin's credential by guessing an id.
        const removed = await deleteCredential(env, session.user_id, params.id);

        if (!removed) {
            // Same response whether the id is unknown or belongs to somebody
            // else — the caller has no business distinguishing those.
            return json({ error: 'Passkey not found' }, 404);
        }

        return json({ success: true });
    } catch (e) {
        console.error('DELETE /api/dashboard/passkeys/:id failed:', e);
        return serverError('Could not remove the passkey');
    }
}
