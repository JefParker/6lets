import { clearedSessionCookie } from '../../../lib/auth.js';

// The session cookie is HttpOnly, so the client cannot clear it itself —
// without this endpoint "Log Out" only hid the UI while the token stayed valid
// for its full lifetime.
export async function onRequestPost() {
    return new Response(JSON.stringify({ success: true }), {
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearedSessionCookie()
        }
    });
}
