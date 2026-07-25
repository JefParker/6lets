import { createSessionToken, sessionCookie, timingSafeEqual } from '../../../lib/auth.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const { username, password } = await request.json();

        // Evaluate both comparisons unconditionally (no early-exit on username).
        const userOk = !!env.DASHBOARD_USERNAME && timingSafeEqual(username || '', env.DASHBOARD_USERNAME);
        const passOk = !!env.DASHBOARD_PASSWORD && timingSafeEqual(password || '', env.DASHBOARD_PASSWORD);

        if (!userOk || !passOk) {
            return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const token = await createSessionToken(env, env.DASHBOARD_USERNAME);

        return new Response(JSON.stringify({ success: true }), {
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': sessionCookie(token)
            }
        });
    } catch (e) {
        // createSessionToken throws if SECRET_KEY is unset — surface that as a
        // server error rather than issuing a token signed with a default.
        return new Response(JSON.stringify({ error: 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
