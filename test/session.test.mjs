import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestAdmin, createTestDatabase, dbSkip } from './helpers/d1.mjs';

import {
    ADMIN_ABSOLUTE_WINDOW_SECONDS,
    ADMIN_IDLE_WINDOW_SECONDS,
    assertSessionWindowsSane,
    createSession,
    getSession,
    isoSeconds,
    SESSION_RENEWAL_THROTTLE_SECONDS,
    sessionCookie
} from '../lib/auth.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// A fixed instant, so every expectation below is arithmetic rather than a race
// with the wall clock. Timestamps are set directly instead of waiting for them —
// a test that sleeps for 72 hours is not a test.
const T0 = Date.parse('2026-08-06T12:00:00Z');

const skip = dbSkip;

async function readSession(env, id) {
    return env.DB.prepare('SELECT * FROM AdminSessions WHERE id = ?').bind(id).first();
}

describe('configuration invariants', () => {
    // The real enforcement is the assertSessionWindowsSane() call at the bottom
    // of lib/auth.js, which throws at import. Asserting the shipped constants
    // here would be a dead test — a violation takes the module graph down
    // before any assertion runs, and while the module loads the condition holds
    // by construction. So test the checker instead, with values it is meant to
    // reject.
    test('the checker rejects a ceiling below the idle window', () => {
        assert.throws(
            () => assertSessionWindowsSane(60 * 60 * 72, 60 * 60 * 24),
            /below the idle window/,
            'a 24h ceiling under a 72h idle window must be refused: it reads as "shorter sessions" and is actually a cookie that dies while its row is still alive'
        );
    });

    test('the checker accepts the shipped constants', () => {
        assert.doesNotThrow(
            () => assertSessionWindowsSane(ADMIN_IDLE_WINDOW_SECONDS, ADMIN_ABSOLUTE_WINDOW_SECONDS)
        );
    });

    test('timestamps are fixed-width, so string comparison is chronological', () => {
        // The renewal SQL MIN/MAXes these as strings. Equal width is what makes
        // that correct; a milliseconds component would silently reorder them.
        assert.equal(isoSeconds(T0).length, 20);
        assert.equal(isoSeconds(T0), '2026-08-06T12:00:00Z');
        assert.ok(isoSeconds(T0) < isoSeconds(T0 + 1000));
    });
});

describe('the session cookie', () => {
    test('carries the absolute window, not the idle one', () => {
        const cookie = sessionCookie('some-session-id');
        const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);

        // Give the cookie the idle window instead and the browser drops it
        // after 72 hours while the row is alive and sliding — a random sign-out
        // with a perfectly good session in the database.
        assert.equal(maxAge, ADMIN_ABSOLUTE_WINDOW_SECONDS);
        assert.notEqual(maxAge, ADMIN_IDLE_WINDOW_SECONDS);
    });

    test('is HttpOnly, Secure and SameSite=Strict', () => {
        const cookie = sessionCookie('some-session-id');
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /Secure/);
        assert.match(cookie, /SameSite=Strict/);
    });
});

describe('sliding expiry', { skip }, () => {
    test('a new session expires on the idle window, not the ceiling', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);

        const session = await createSession(env, userId, { now: T0 });

        assert.equal(session.expiresAt, isoSeconds(T0 + ADMIN_IDLE_WINDOW_SECONDS * 1000));
        assert.equal(session.absoluteExpiresAt, isoSeconds(T0 + ADMIN_ABSOLUTE_WINDOW_SECONDS * 1000));
        assert.notEqual(session.expiresAt, session.absoluteExpiresAt);
    });

    test('using it pushes the expiry forward', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        const later = T0 + 20 * MINUTE;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: later });

        const row = await readSession(env, session.id);
        assert.equal(row.expires_at, isoSeconds(later + ADMIN_IDLE_WINDOW_SECONDS * 1000));
        assert.ok(row.expires_at > session.expiresAt);
        assert.equal(row.last_seen_at, isoSeconds(later));
    });

    test('a second read seconds later writes nothing', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        const first = T0 + 20 * MINUTE;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: first });
        const afterFirst = await readSession(env, session.id);

        // The dashboard fires four API calls on load. Without the throttle
        // that is four writes per page view.
        const soonAfter = first + 30 * 1000;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: soonAfter });
        const afterSecond = await readSession(env, session.id);

        assert.equal(afterSecond.last_seen_at, afterFirst.last_seen_at);
        assert.equal(afterSecond.expires_at, afterFirst.expires_at);
    });

    test('writes again once the throttle window has passed', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        const first = T0 + 20 * MINUTE;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: first });

        const past = first + (SESSION_RENEWAL_THROTTLE_SECONDS + 60) * 1000;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: past });

        const row = await readSession(env, session.id);
        assert.equal(row.last_seen_at, isoSeconds(past));
    });

    test('renewal cannot pass the ceiling', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        // Drop the ceiling BELOW the current expiry. This is the case that
        // caught the MIN/MAX bug: cap in application code and then write
        // `CASE WHEN capped > expires_at THEN capped ELSE expires_at END` and
        // never-shortening quietly outranks the ceiling, because pulling an
        // over-cap expiry back down *is* shortening. The bound has to win.
        const ceiling = isoSeconds(T0 + HOUR);
        await env.DB.prepare('UPDATE AdminSessions SET absolute_expires_at = ? WHERE id = ?')
            .bind(ceiling, session.id).run();

        const later = T0 + 20 * MINUTE;
        await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: later });

        const row = await readSession(env, session.id);
        assert.equal(row.expires_at, ceiling, 'the ceiling must clamp the renewed expiry');
    });

    test('a shorter idle window does not shorten a live session', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        // Somebody lowers the idle window in config while sessions are open. An
        // ordinary page load must not become a sign-out for whoever is
        // mid-sentence.
        const later = T0 + 20 * MINUTE;
        await getSession(env, session.id, { idleWindowSeconds: 3600, now: later });

        const row = await readSession(env, session.id);
        assert.equal(row.expires_at, session.expiresAt, 'expiry must never move backwards on use');
    });

    test('sliding is opt-in: no idle window means no write', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        // Sessions for other subject types keep flat behaviour until somebody
        // deliberately passes a window.
        const later = T0 + 20 * MINUTE;
        const found = await getSession(env, session.id, { now: later });
        assert.ok(found);

        const row = await readSession(env, session.id);
        assert.equal(row.last_seen_at, isoSeconds(T0));
        assert.equal(row.expires_at, session.expiresAt);
    });
});

describe('the two ways a session ends', { skip }, () => {
    test('idle: unused for longer than the idle window', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        const afterIdle = T0 + (ADMIN_IDLE_WINDOW_SECONDS + 60) * 1000;
        assert.equal(
            await getSession(env, session.id, { idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: afterIdle }),
            null
        );
    });

    test('ceiling: still in use, but past its absolute expiry', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);

        // A two-hour ceiling under a long idle window, so only the ceiling can
        // be what ends it.
        const session = await createSession(env, userId, { now: T0, absoluteWindowSeconds: 2 * 60 * 60 });

        // Used regularly right up to the ceiling...
        const beforeCeiling = T0 + 90 * MINUTE;
        assert.ok(await getSession(env, session.id, {
            idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: beforeCeiling
        }));

        // ...and refused immediately after it, however active it was.
        const afterCeiling = T0 + 3 * HOUR;
        assert.equal(await getSession(env, session.id, {
            idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: afterCeiling
        }), null);
    });

    test('a deleted session stops working at once', async () => {
        const { env } = createTestDatabase();
        const userId = await createTestAdmin(env);
        const session = await createSession(env, userId, { now: T0 });

        await env.DB.prepare('DELETE FROM AdminSessions WHERE id = ?').bind(session.id).run();

        // The property the old stateless token could not offer: revocation.
        assert.equal(await getSession(env, session.id, {
            idleWindowSeconds: ADMIN_IDLE_WINDOW_SECONDS, now: T0 + MINUTE
        }), null);
    });
});
