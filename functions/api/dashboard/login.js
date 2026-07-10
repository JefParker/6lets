export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const { username, password } = await request.json();
        if (username === env.DASHBOARD_USERNAME && password === env.DASHBOARD_PASSWORD) {
            // Generate simple auth token
            const payload = btoa(JSON.stringify({ user: username, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })); // 1 week
            
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey('raw', encoder.encode(env.SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
            const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
            
            const token = `${payload}.${signature}`;

            return new Response(JSON.stringify({ success: true }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `auth_token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict`
                }
            });
        }
        return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
    }
}
