// /api/results must not trust the client's verdict.
//
// The incident these tests pin down: a client that never learned the day's
// word played against its offline fallback (SODIUM), honestly reported a win,
// and synced it. The leaderboard listed the player as solved but scored the
// guesses server-side against the real word (PHASES), rendering a "solved" row
// whose grid never turns green. The fix is to derive solved_successfully (and
// guesses_taken) from the guesses blob whenever one is present, and only fall
// back to the client's flags for blob-less records from older clients.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dbSkip } from './helpers/d1.mjs';
import { onRequestPost } from '../functions/api/results.js';

const GAME_ID = '2026-08-11-AM';
const UUID = '11111111-1111-4111-8111-111111111111';

function makeContext(env, payload) {
    return { env, request: { json: async () => payload } };
}

async function seededDb(word = 'PHASES') {
    const { env } = createTestDatabase();
    await env.DB.prepare('INSERT INTO DailyWords (id, word) VALUES (?, ?)')
        .bind(GAME_ID, word).run();
    return env;
}

function record(overrides = {}) {
    return {
        user_uuid: UUID,
        game_id: GAME_ID,
        guesses_taken: 3,
        time_taken_ms: 60000,
        solved_successfully: true,
        guesses: JSON.stringify(['STAPLE', 'PHRASE', 'PHASES']),
        ...overrides
    };
}

async function storedRow(env) {
    return env.DB.prepare('SELECT * FROM Results WHERE user_uuid = ? AND game_id = ?')
        .bind(UUID, GAME_ID).first();
}

test('a claimed win whose guesses never hit the word is stored unsolved', { skip: dbSkip }, async () => {
    const env = await seededDb();
    const res = await onRequestPost(makeContext(env, [record({
        guesses: JSON.stringify(['STAPLE', 'SODIUM']),
        guesses_taken: 2,
        solved_successfully: true
    })]));
    assert.equal((await res.json()).accepted, 1);

    const row = await storedRow(env);
    assert.equal(row.solved_successfully, 0);
});

test('a genuine win is stored solved', { skip: dbSkip }, async () => {
    const env = await seededDb();
    await onRequestPost(makeContext(env, [record()]));

    const row = await storedRow(env);
    assert.equal(row.solved_successfully, 1);
    assert.equal(row.guesses_taken, 3);
});

test('scoring is case-insensitive against the stored word', { skip: dbSkip }, async () => {
    const env = await seededDb('phases');
    await onRequestPost(makeContext(env, [record({
        guesses: JSON.stringify(['phases']),
        guesses_taken: 1
    })]));

    const row = await storedRow(env);
    assert.equal(row.solved_successfully, 1);
});

test('guesses_taken comes from the blob, not the client claim', { skip: dbSkip }, async () => {
    const env = await seededDb();
    await onRequestPost(makeContext(env, [record({
        guesses_taken: 1, // claims a first-guess solve...
        guesses: JSON.stringify(['STAPLE', 'PHRASE', 'SHAPED', 'PHASES']) // ...took four
    })]));

    const row = await storedRow(env);
    assert.equal(row.guesses_taken, 4);
    assert.equal(row.solved_successfully, 1);
});

test('a blob-less record (older client) keeps the client flags', { skip: dbSkip }, async () => {
    const env = await seededDb();
    await onRequestPost(makeContext(env, [record({ guesses: null })]));

    const row = await storedRow(env);
    assert.equal(row.solved_successfully, 1);
    assert.equal(row.guesses_taken, 3);
});

test('a malformed blob drops the record instead of storing junk', { skip: dbSkip }, async () => {
    const env = await seededDb();
    const bad = [
        record({ guesses: 'not json' }),
        record({ guesses: JSON.stringify(['TOO-LONG-FOR-A-GUESS']) }),
        record({ guesses: JSON.stringify([]) }),
        record({ guesses: JSON.stringify([1, 2, 3]) })
    ];
    const res = await onRequestPost(makeContext(env, bad));
    const body = await res.json();

    assert.equal(body.accepted, 0);
    assert.equal(body.skipped, 4);
    assert.equal(await storedRow(env), null);
});

test('an unknown game_id is still skipped', { skip: dbSkip }, async () => {
    const env = await seededDb();
    const res = await onRequestPost(makeContext(env, [record({ game_id: '2026-08-12-PM' })]));
    const body = await res.json();

    assert.equal(body.accepted, 0);
    assert.equal(body.skipped, 1);
});
