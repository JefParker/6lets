import {
    bootstrapAdminFromEnv,
    createSession,
    DECOY_PASSWORD_HASH,
    findAdminByUsername,
    sessionCookie,
    verifyPassword
} from '../../../lib/auth.js';

// Password sign-in. Still the primary route in, and still the only one that
// works from a device that has never been enrolled — see the note on
// AdminUsers.password_hash in migrations/0001_admin_auth_and_sessions.sql for
// why passkeys did not replace this.

export async function onRequestPost(context) {
    const { request, env } = context;

    let username, password;
    try {
        ({ username, password } = await request.json());
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Malformed request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {

        // Seeds AdminUsers from the environment credential the first time this
        // runs against an empty table, so deploying the migration cannot lock
        // the dashboard. Inert once any admin row exists.
        await bootstrapAdminFromEnv(env);

        const admin = await findAdminByUsername(env, username || '');

        // Derive either way, exactly once either way. Returning early on an
        // unknown username makes that response measurably faster than a wrong
        // password against a real one, and 100k PBKDF2 iterations is a big
        // enough difference to read over the network — which turns this
        // endpoint into a username oracle.
        //
        // DECOY_PASSWORD_HASH is a module constant rather than a fresh
        // hashPassword() call precisely so this stays one derivation; see the
        // note on it in lib/auth.js.
        const passOk = await verifyPassword(password || '', admin ? admin.password_hash : DECOY_PASSWORD_HASH);

        if (!admin || !passOk || admin.disabled_at) {
            // One message for all three. Distinguishing them tells an attacker
            // which usernames exist and which accounts are merely disabled.
            console.warn('Dashboard login refused:',
                !admin ? 'unknown username' : admin.disabled_at ? 'account disabled' : 'bad password');
            return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const session = await createSession(env, admin.id);

        return new Response(JSON.stringify({ success: true }), {
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': sessionCookie(session.id)
            }
        });
    } catch (e) {
        console.error('POST /api/dashboard/login failed:', e);
        return new Response(JSON.stringify({ error: 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
