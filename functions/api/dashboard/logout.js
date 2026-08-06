import { clearedSessionCookie, deleteSession, readSessionId } from '../../../lib/auth.js';

// The session cookie is HttpOnly, so the client cannot clear it itself —
// without this endpoint "Log Out" only hid the UI while the session stayed
// valid for its full lifetime.
//
// Now that sessions are rows rather than self-contained tokens, this also
// *revokes*: the row is deleted, so a copy of the cookie taken beforehand stops
// working immediately instead of remaining good until its expiry. That was not
// possible while the token carried its own claims.
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const sessionId = readSessionId(request);
        if (sessionId) await deleteSession(env, sessionId);
    } catch (e) {
        // Still clear the cookie below. A logout that fails because the
        // database is unreachable should not leave the browser holding a
        // cookie that looks signed-in.
        console.error('POST /api/dashboard/logout could not delete the session row:', e);
    }

    return new Response(JSON.stringify({ success: true }), {
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearedSessionCookie()
        }
    });
}
