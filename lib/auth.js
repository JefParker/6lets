// Shared dashboard auth helpers.

export const AUTH_COOKIE = 'auth_token';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 1 week

// Length-independent, constant-time string comparison to avoid leaking the
// credential via response timing. Folds the length difference into the
// accumulator so mismatched lengths can never compare equal.
export function timingSafeEqual(a, b) {
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

// Fail loudly rather than silently HMAC-ing with the literal bytes "undefined",
// which is what `encoder.encode(env.SECRET_KEY)` does when the binding is unset.
function requireSecret(env) {
    const secret = env.SECRET_KEY;
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('SECRET_KEY is not configured');
    }
    return secret;
}

async function importKey(env, usages) {
    const encoder = new TextEncoder();
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(requireSecret(env)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        usages
    );
}

export async function createSessionToken(env, username) {
    const payload = btoa(JSON.stringify({
        user: username,
        exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
    }));

    const encoder = new TextEncoder();
    const key = await importKey(env, ['sign']);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    return `${payload}.${signature}`;
}

export function sessionCookie(token) {
    return `${AUTH_COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Strict`;
}

export function clearedSessionCookie() {
    return `${AUTH_COOKIE}=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
}

export async function verifyAuth(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;

    const cookies = cookieHeader.split(';').map(c => c.trim());
    const authCookie = cookies.find(c => c.startsWith(`${AUTH_COOKIE}=`));
    if (!authCookie) return false;

    const token = authCookie.substring(`${AUTH_COOKIE}=`.length);
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

    const [payload, signature] = parts;

    try {
        const encoder = new TextEncoder();
        const key = await importKey(env, ['verify']);

        const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload));
        if (!isValid) return false;

        const decodedPayload = JSON.parse(atob(payload));

        if (typeof decodedPayload.exp !== 'number' || decodedPayload.exp < Date.now()) return false;

        // The signature proves we issued the token; also confirm it names the
        // account that is currently configured, so rotating DASHBOARD_USERNAME
        // invalidates tokens issued for the old one.
        if (!env.DASHBOARD_USERNAME || decodedPayload.user !== env.DASHBOARD_USERNAME) return false;

        return true;
    } catch (e) {
        return false;
    }
}
