// The scheduling runway: how many half-days of words exist from the current
// game forward, and the automatic top-up that keeps that number at or above
// the floor.
//
// The floor exists because running out of words is now a hard outage: since
// the offline-fallback removal, a missing half-day means every player gets
// the retry panel instead of silently playing the wrong word. Top-up runs
// lazily from /api/words — the endpoint every client hits on every load — so
// it needs no cron, and INSERT OR IGNORE makes concurrent top-ups from
// parallel requests harmless (first writer wins per id).
//
// Words come from AnswerPool (curated, see migrations/0002_answer_pool.sql).
// A candidate is available while it appears nowhere in DailyWords, so nothing
// is ever scheduled twice regardless of whether the dashboard, the manual
// generator, or this code scheduled it first. Assignment uses SQLite's
// RANDOM() — weaker than the manual generator's SystemRandom, which is fine
// for the emergency floor and irrelevant to anyone without the pool's
// remaining contents.

import { getCurrentGameId, nextGameIds } from './puzzle.js';

export const RUNWAY_TARGET_HALF_DAYS = 80; // 40 days

// Contiguous coverage from the current game: how far a player could get
// before hitting a missing half-day. A gap ends the runway even if later
// dates are scheduled, because the game breaks on the gap day, not after the
// last row.
export async function runwayStatus(env, now = new Date()) {
    const wanted = nextGameIds(getCurrentGameId(now), RUNWAY_TARGET_HALF_DAYS);

    const { results } = await env.DB.prepare(
        'SELECT id FROM DailyWords WHERE id >= ? ORDER BY id ASC LIMIT ?'
    ).bind(wanted[0], RUNWAY_TARGET_HALF_DAYS).all();
    const existing = new Set(results.map(row => row.id));

    let contiguous = 0;
    while (contiguous < wanted.length && existing.has(wanted[contiguous])) contiguous++;

    const pool = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM AnswerPool WHERE word NOT IN (SELECT word FROM DailyWords)'
    ).first();

    return {
        halfDays: contiguous,
        days: Math.floor(contiguous / 2),
        targetDays: RUNWAY_TARGET_HALF_DAYS / 2,
        scheduledThrough: contiguous > 0 ? wanted[contiguous - 1] : null,
        poolAvailable: pool.n
    };
}

// Fill every missing half-day in the target window — gaps and the tail alike
// — from the pool. Returns what happened; never throws pool-shortage as an
// error, because a partial top-up is strictly better than none and the
// dashboard indicator is where a dry pool gets surfaced.
export async function ensureRunway(env, now = new Date()) {
    const wanted = nextGameIds(getCurrentGameId(now), RUNWAY_TARGET_HALF_DAYS);

    const { results } = await env.DB.prepare(
        'SELECT id FROM DailyWords WHERE id >= ? AND id <= ? ORDER BY id ASC'
    ).bind(wanted[0], wanted[wanted.length - 1]).all();
    const existing = new Set(results.map(row => row.id));

    const missing = wanted.filter(id => !existing.has(id));
    if (missing.length === 0) return { added: 0, shortfall: 0 };

    const { results: picks } = await env.DB.prepare(
        `SELECT word FROM AnswerPool
          WHERE word NOT IN (SELECT word FROM DailyWords)
          ORDER BY RANDOM() LIMIT ?`
    ).bind(missing.length).all();

    if (picks.length === 0) return { added: 0, shortfall: missing.length };

    const stmt = env.DB.prepare(
        'INSERT INTO DailyWords (id, word) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
    );
    const batch = missing.slice(0, picks.length).map((id, i) => stmt.bind(id, picks[i].word));
    await env.DB.batch(batch);

    return { added: batch.length, shortfall: missing.length - batch.length };
}
