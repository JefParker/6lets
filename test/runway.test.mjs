// lib/runway.js — the 40-day scheduling floor.
//
// What must hold: ensureRunway fills every missing half-day in the target
// window (tail AND mid-schedule gaps) from AnswerPool; a word never appears
// twice in DailyWords no matter who scheduled it first; a dry pool degrades
// to a partial fill and a truthful status, never an error; and runwayStatus
// counts only contiguous coverage, because a gap breaks the game on the gap
// day regardless of what is scheduled after it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dbSkip } from './helpers/d1.mjs';
import { getCurrentGameId, nextGameIds } from '../lib/puzzle.js';
import { ensureRunway, runwayStatus, RUNWAY_TARGET_HALF_DAYS } from '../lib/runway.js';
import { onRequestGet as getWords } from '../functions/api/words.js';

const WANTED = nextGameIds(getCurrentGameId(), RUNWAY_TARGET_HALF_DAYS);

// Distinct 6-letter pool words: POOLAA, POOLAB, ...
function poolWords(count) {
    return Array.from({ length: count }, (_, i) =>
        'POOL' + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
}

async function seedPool(env, words) {
    for (const word of words) {
        await env.DB.prepare('INSERT OR IGNORE INTO AnswerPool (word) VALUES (?)').bind(word).run();
    }
}

async function scheduledIds(env) {
    const { results } = await env.DB.prepare('SELECT id, word FROM DailyWords ORDER BY id').all();
    return results;
}

test('an empty schedule is filled to the full target window', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    await seedPool(env, poolWords(100));

    const result = await ensureRunway(env);
    assert.equal(result.added, RUNWAY_TARGET_HALF_DAYS);
    assert.equal(result.shortfall, 0);

    const status = await runwayStatus(env);
    assert.equal(status.halfDays, RUNWAY_TARGET_HALF_DAYS);
    assert.equal(status.days, RUNWAY_TARGET_HALF_DAYS / 2);
    assert.equal(status.scheduledThrough, WANTED[RUNWAY_TARGET_HALF_DAYS - 1]);
});

test('a mid-schedule gap ends the reported runway and gets refilled', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    await seedPool(env, poolWords(100));
    await ensureRunway(env);

    await env.DB.prepare('DELETE FROM DailyWords WHERE id = ?').bind(WANTED[5]).run();

    const status = await runwayStatus(env);
    assert.equal(status.halfDays, 5); // contiguity stops at the hole, not at the last row

    const refill = await ensureRunway(env);
    assert.equal(refill.added, 1);
    assert.equal((await runwayStatus(env)).halfDays, RUNWAY_TARGET_HALF_DAYS);
});

test('no word is ever scheduled twice, and hand-scheduled words leave the pool', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    const pool = poolWords(RUNWAY_TARGET_HALF_DAYS); // exactly enough — every word must be used once
    await seedPool(env, pool);
    // Hand-schedule a pool word for the current game, as the dashboard would.
    await env.DB.prepare('INSERT INTO DailyWords (id, word) VALUES (?, ?)')
        .bind(WANTED[0], pool[0]).run();

    const result = await ensureRunway(env);
    // One id pre-filled and one pool word consumed by hand: 79 slots remain
    // but only 79 candidates too, so the fill still completes exactly.
    assert.equal(result.added, RUNWAY_TARGET_HALF_DAYS - 1);

    const rows = await scheduledIds(env);
    const words = rows.map(r => r.word);
    assert.equal(new Set(words).size, words.length, 'a word was scheduled twice');
    assert.equal((await runwayStatus(env)).poolAvailable, 0);
});

test('a dry pool degrades to a partial fill and an honest status', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    await seedPool(env, poolWords(10));

    const result = await ensureRunway(env);
    assert.equal(result.added, 10);
    assert.equal(result.shortfall, RUNWAY_TARGET_HALF_DAYS - 10);

    const status = await runwayStatus(env);
    assert.equal(status.days, 5);
    assert.equal(status.poolAvailable, 0);

    // And an empty pool on an empty window is a no-op, not a crash.
    const again = await ensureRunway(env);
    assert.equal(again.added, 0);
    assert.equal(again.shortfall, RUNWAY_TARGET_HALF_DAYS - 10);
});

test('/api/words triggers the top-up and serves the topped-up schedule', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    env.SECRET_KEY = 'test-secret';
    await seedPool(env, poolWords(100));

    const res = await getWords({ env });
    assert.equal(res.status, 200);
    const payload = await res.json();

    // 8 plaintext + 60 sealed — the feed's cap, all filled by the top-up.
    assert.equal(payload.length, 68);
    assert.equal(payload[0].id, WANTED[0]);
});
