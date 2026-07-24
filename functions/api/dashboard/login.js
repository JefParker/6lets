// Length-independent, constant-time string comparison to avoid leaking the
// credential via response timing. Folds the length difference into the
// accumulator so mismatched lengths can never compare equal.
function timingSafeEqual(a, b) {
    const enc = new TextEncoder();
    const ab = enc.encode(a);
    const bb = enc.encode(b);
    let diff = ab.length ^ bb.length;
    const len = Math.max(ab.length, bb.length);
    for (let i = 0; i < len; i++) {
        diff |= (ab[i] || 0) ^ (bb[i] || 0);
    }
    return diff === 0;
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const { username, password } = await request.json();
        // Evaluate both comparisons unconditionally (no early-exit on username).
        const userOk = !!env.DASHBOARD_USERNAME && timingSafeEqual(username || '', env.DASHBOARD_USERNAME);
        const passOk = !!env.DASHBOARD_PASSWORD && timingSafeEqual(password || '', env.DASHBOARD_PASSWORD);
        if (userOk && passOk) {
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
