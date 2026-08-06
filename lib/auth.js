// Shared dashboard auth helpers.
//
// Sessions are rows in D1 (`AdminSessions`) and the cookie carries an opaque
// id. They used to be a self-contained HMAC token, which meant "Log Out" could
// only clear the cookie — the token itself stayed valid for its full lifetime
// in anyone else's hands. A row can be deleted.

export const AUTH_COOKIE = 'auth_token';

// Two windows, not one lifetime.
//
// With a single fixed lifetime the fix for "it logs me out too often" is a
// bigger number, and a flat 90 days means a stolen cookie is good for three
// months whether or not anybody used it. So:
//
//   idle     — dies if unused, and is pushed forward every time it is used
//   absolute — dies on a fixed date however much it is used, so no session
//              is immortal
export const ADMIN_IDLE_WINDOW_SECONDS = 60 * 60 * 72;      // 72 hours
export const ADMIN_ABSOLUTE_WINDOW_SECONDS = 60 * 60 * 24 * 90; // 90 days

// Only write last_seen_at/expires_at if the session has not been touched for
// this long. The dashboard fires four API calls on load; without a throttle
// that is four writes per page view for no benefit. Fifteen minutes of drift
// on a window measured in days is nothing.
export const SESSION_RENEWAL_THROTTLE_SECONDS = 60 * 15;

// A ceiling below the idle window reads like "shorter sessions" and is
// actually a cookie that expires while its row is still alive and sliding —
// i.e. a random sign-out with a perfectly good session sitting in the
// database. Fail at import rather than at 3am.
//
// Exported so the test can call it with deliberately bad values. Asserting the
// invariant on the real constants would be a dead test: this module throws at
// import, so a violation takes the whole module graph down before any assertion
// runs, and while the module *does* load the condition is true by construction.
export function assertSessionWindowsSane(idleSeconds, ceilingSeconds) {
    if (ceilingSeconds < idleSeconds) {
        throw new Error(
            `Session ceiling (${ceilingSeconds}s) is below the idle window (${idleSeconds}s). ` +
            `The cookie carries the ceiling, so it would expire while the session row was ` +
            `still alive and sliding — a random sign-out with a good session in the database.`
        );
    }
}

assertSessionWindowsSane(ADMIN_IDLE_WINDOW_SECONDS, ADMIN_ABSOLUTE_WINDOW_SECONDS);

// Sorts after every real timestamp, and is the same width as one.
const NEVER = '9999-12-31T23:59:59Z';

// Fixed-width ISO-8601 in UTC, seconds precision: YYYY-MM-DDTHH:MM:SSZ
//
// Always use this rather than toISOString() directly. Session renewal compares
// and MIN/MAXes these values as strings inside SQL, and string comparison is
// only chronological while every value is exactly the same length — a stray
// milliseconds component makes '...T00:00:00.5Z' sort after '...T00:00:01Z'
// and the comparison silently produces the wrong answer instead of failing.
export function isoSeconds(input = Date.now()) {
    const date = input instanceof Date ? input : new Date(input);
    return `${date.toISOString().slice(0, 19)}Z`;
}

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

// ------------------------------------------------------------- passwords ---

// 100,000 is not a round number picked for taste — it is exactly Cloudflare's
// ceiling. workerd rejects anything above it with
// `NotSupportedError: iteration counts above 100000 are not supported`, so this
// cannot be raised on this runtime however much the advice moves on. If you
// need more work per guess, the lever is a different KDF, not this constant.
const PBKDF2_ITERATIONS = 100000;

function toBase64url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256
    );
    return new Uint8Array(bits);
}

// Stored as `pbkdf2$sha256$<iterations>$<salt>$<hash>`, all base64url.
//
// The iteration count travels with the hash rather than being read from the
// constant above, so changing PBKDF2_ITERATIONS does not invalidate every
// existing password — old hashes keep verifying at the count they were made
// with, and get the new one next time the password is set.
export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64url(salt)}$${toBase64url(hash)}`;
}

// What the login route verifies against when the username is unknown, so that
// both paths do exactly one PBKDF2 derivation.
//
// It is a constant, not a freshly generated hash. The obvious spelling —
// `verifyPassword(password, await hashPassword('decoy'))` — runs *two*
// derivations on the unknown-username path (one to build the decoy, one to
// check against it) against one on the known-username path. That does not
// remove the timing signal, it doubles it and points it the other way: an
// unknown username becomes the slow answer, which is just as good an oracle.
//
// The digest corresponds to no password. verifyPassword derives from the
// candidate and compares, which is all the timing needs; the comparison simply
// always fails.
const DECOY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';                                    // 16 bytes
const DECOY_DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';            // 32 bytes
export const DECOY_PASSWORD_HASH = `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${DECOY_SALT}$${DECOY_DIGEST}`;

export async function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;

    const iterations = parseInt(parts[2], 10);
    if (!Number.isInteger(iterations) || iterations < 1) return false;

    let salt;
    try {
        salt = Uint8Array.from(atob(parts[3].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    } catch (e) {
        return false;
    }

    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(toBase64url(actual), parts[4]);
}

// ---------------------------------------------------------------- cookie ---

// ⚠ The cookie carries the ABSOLUTE window, and is never refreshed.
//
// This is the decision that keeps sliding expiry to one file.
//
// Give the cookie the idle window instead and the browser discards it after 72
// hours while the row in D1 is alive and happily sliding — which presents as a
// random sign-out with a perfectly good session in the database, and is
// miserable to diagnose. Give it the ceiling and it always outlives the session
// it names.
//
// The cookie can therefore name a session that has since gone idle. That is not
// a hole: the id is opaque and carries no claims, and getSession's WHERE clause
// refuses an idle row exactly as it refuses a deleted one. The alternative —
// keeping the cookie in step with the sliding value — is a Set-Cookie on every
// response in the project.
//
// Local-dev footnote: `Secure` is kept unconditionally. Chrome and Firefox
// accept Secure cookies on http://localhost, Safari does not — so signing in
// against `wrangler pages dev` in Safari appears to succeed and then does
// nothing, because the cookie was dropped. Use Chrome for local admin work.
// Making the flag conditional on hostname is a worse trade: it is one typo away
// from shipping a session cookie that is not Secure in production.
export function sessionCookie(sessionId) {
    return `${AUTH_COOKIE}=${sessionId}; HttpOnly; Secure; Path=/; Max-Age=${ADMIN_ABSOLUTE_WINDOW_SECONDS}; SameSite=Strict`;
}

export function clearedSessionCookie() {
    return `${AUTH_COOKIE}=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
}

export function readSessionId(request) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').map(c => c.trim());
    const authCookie = cookies.find(c => c.startsWith(`${AUTH_COOKIE}=`));
    if (!authCookie) return null;

    const value = authCookie.substring(`${AUTH_COOKIE}=`.length);
    return value.length > 0 ? value : null;
}

// -------------------------------------------------------------- sessions ---

export async function createSession(env, userId, {
    now = Date.now(),
    idleWindowSeconds = ADMIN_IDLE_WINDOW_SECONDS,
    absoluteWindowSeconds = ADMIN_ABSOLUTE_WINDOW_SECONDS,
    subjectType = 'admin'
} = {}) {
    const id = crypto.randomUUID();
    const createdAt = isoSeconds(now);

    // A brand-new session expires on the idle window, not the ceiling. The
    // ceiling is only ever an upper bound on how far renewal can push it.
    const expiresAt = isoSeconds(now + idleWindowSeconds * 1000);
    const absoluteExpiresAt = isoSeconds(now + absoluteWindowSeconds * 1000);

    await env.DB.prepare(
        `INSERT INTO AdminSessions
             (id, user_id, subject_type, created_at, last_seen_at, expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, subjectType, createdAt, createdAt, expiresAt, absoluteExpiresAt).run();

    return { id, expiresAt, absoluteExpiresAt };
}

export async function deleteSession(env, sessionId) {
    await env.DB.prepare('DELETE FROM AdminSessions WHERE id = ?').bind(sessionId).run();
}

// Look up a session, and slide it *only* if an idle window is passed.
//
// Sliding is opt-in per call site on purpose. Pass `idleWindowSeconds` from the
// guard that protected admin routes go through, and nowhere else. Sessions
// belonging to some other kind of subject — a service account, a second class
// of user — then keep their existing flat behaviour until somebody decides
// otherwise, and that decision is one argument at one call site rather than an
// accident of having reused this helper.
export async function getSession(env, sessionId, { idleWindowSeconds = null, now = Date.now() } = {}) {
    if (!sessionId) return null;

    const nowIso = isoSeconds(now);

    // Both deadlines are enforced here, which is what lets the cookie carry the
    // ceiling without the ceiling becoming the real lifetime.
    const session = await env.DB.prepare(
        `SELECT id, user_id, subject_type, created_at, last_seen_at, expires_at, absolute_expires_at
           FROM AdminSessions
          WHERE id = ?
            AND expires_at > ?
            AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)`
    ).bind(sessionId, nowIso, nowIso).first();

    if (!session) return null;
    if (idleWindowSeconds === null) return session;

    const wantedExpiry = isoSeconds(now + idleWindowSeconds * 1000);
    const throttleCutoff = isoSeconds(now - SESSION_RENEWAL_THROTTLE_SECONDS * 1000);

    // ⚠ MIN(ceiling, MAX(current, wanted)). The nesting is the point.
    //
    //   MAX(current, wanted) — never shorten. A clock that steps backwards, or
    //     an idle window lowered in config while sessions are open, must not
    //     turn an ordinary page load into a sign-out for somebody mid-sentence.
    //
    //   MIN(ceiling, ...)    — the hard bound, applied last so it wins.
    //
    // Do not merge these into a single comparison, and in particular do not cap
    // in JavaScript and then write `CASE WHEN capped > expires_at THEN capped
    // ELSE expires_at END`: that quietly ranks never-shorten above the ceiling,
    // because an expiry already past the cap cannot be pulled back — pulling it
    // back is shortening. A security bound that yields to a convenience rule is
    // not a bound. This ordering is what the "renewal cannot pass the ceiling"
    // test in test/session.test.mjs pins down.
    //
    // The ceiling is read from the row inside the UPDATE, not from the SELECT
    // above, so nothing can have moved between the two statements.
    //
    // The throttle lives in the WHERE clause rather than in an `if` around this
    // call: making the write itself conditional means concurrent requests race
    // on the database instead of on a value each of them read separately.
    await env.DB.prepare(
        `UPDATE AdminSessions
            SET last_seen_at = ?,
                expires_at = MIN(
                    COALESCE(absolute_expires_at, '${NEVER}'),
                    MAX(expires_at, ?)
                )
          WHERE id = ?
            AND last_seen_at <= ?`
    ).bind(nowIso, wantedExpiry, sessionId, throttleCutoff).run();

    return session;
}

// The guard every protected admin route goes through, and the only place the
// idle window is passed.
export async function requireAdminSession(request, env) {
    const session = await getSession(env, readSessionId(request), {
        idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS
    });
    if (!session || session.subject_type !== 'admin') return null;
    return session;
}

// Boolean wrapper, kept so existing route guards read the way they did.
export async function verifyAuth(request, env) {
    return (await requireAdminSession(request, env)) !== null;
}

// ----------------------------------------------------------- admin users ---

export async function findAdminByUsername(env, username) {
    return env.DB.prepare(
        'SELECT id, username, password_hash, disabled_at FROM AdminUsers WHERE username = ?'
    ).bind(username).first();
}

// First-run bootstrap: seed AdminUsers from the DASHBOARD_USERNAME /
// DASHBOARD_PASSWORD environment credential.
//
// Runs only when the table is completely empty. Without it, deploying this
// change locks the dashboard until someone remembers to run
// tools/create-admin.sh — and the moment you are locked out is the worst moment
// to be reading a script's usage text. It grants nothing that the environment
// credential did not already grant.
//
// Once a row exists this is inert, so rotating DASHBOARD_PASSWORD afterwards no
// longer changes the login. Use tools/create-admin.sh for that; the environment
// variable is a seed, not the source of truth.
export async function bootstrapAdminFromEnv(env) {
    const username = env.DASHBOARD_USERNAME;
    const password = env.DASHBOARD_PASSWORD;
    if (!username || !password) return null;

    const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM AdminUsers').first();
    if (existing && existing.n > 0) return null;

    const id = crypto.randomUUID();

    // DO NOTHING rather than a bare INSERT: the COUNT above and this write are
    // not one transaction, so two simultaneous first logins can both read zero.
    // Without it the loser violates AdminUsers.username UNIQUE and the very
    // first login anyone ever attempts returns a 500.
    await env.DB.prepare(
        `INSERT INTO AdminUsers (id, username, password_hash, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO NOTHING`
    ).bind(id, username, await hashPassword(password), isoSeconds()).run();

    console.log(`Bootstrapped AdminUsers from environment credential for "${username}"`);
    return { id, username };
}
