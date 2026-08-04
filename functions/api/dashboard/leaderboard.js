import { GAME_ID_PATTERN } from '../../../lib/puzzle.js';

const MAX_PATTERN_ROWS = 10;
const WORD_LENGTH = 6;

// Wordle-style scoring, duplicate-letter aware: exact matches are claimed first,
// then each remaining target letter can satisfy at most one present marker.
//
// This runs on the server on purpose. The client could derive the same grid from
// the raw guess words, but returning those words would hand the answer to anyone
// who hits this endpoint — the last guess of every solved row *is* the target.
// Only the emoji pattern leaves the worker.
function toEmojiRow(guess, target) {
    const targetChars = target.split('');
    const statuses = new Array(WORD_LENGTH).fill('absent');

    for (let i = 0; i < WORD_LENGTH; i++) {
        if (guess[i] === targetChars[i]) {
            statuses[i] = 'correct';
            targetChars[i] = null;
        }
    }
    for (let i = 0; i < WORD_LENGTH; i++) {
        if (statuses[i] === 'correct') continue;
        const idx = targetChars.indexOf(guess[i]);
        if (idx !== -1) {
            statuses[i] = 'present';
            targetChars[idx] = null;
        }
    }

    return statuses
        .map(s => (s === 'correct' ? '🟩' : s === 'present' ? '🟨' : '⬛'))
        .join('');
}

// `guesses` is a player-supplied JSON blob, so treat every part of it as
// untrusted: bad JSON, wrong shape, or wrong-length words yield null rather than
// breaking the whole leaderboard response.
function buildPattern(guessesBlob, target) {
    if (!guessesBlob || !target || target.length !== WORD_LENGTH) return null;

    let parsed;
    try {
        parsed = JSON.parse(guessesBlob);
    } catch (e) {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const rows = [];
    for (const guess of parsed.slice(0, MAX_PATTERN_ROWS)) {
        if (typeof guess !== 'string' || guess.length !== WORD_LENGTH) return null;
        rows.push(toEmojiRow(guess.toUpperCase(), target));
    }
    return rows;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const game_id = url.searchParams.get('game_id');

    if (!game_id || !GAME_ID_PATTERN.test(game_id)) {
        return new Response(JSON.stringify({ error: 'Invalid or missing game_id' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // DailyWords is joined rather than queried separately so scoring the
        // grids costs no extra round trip. LEFT JOIN keeps the leaderboard
        // working if the word row is ever missing — those rows just get a null
        // pattern instead of failing.
        const { results } = await env.DB.prepare(
            `SELECT u.display_name, r.guesses_taken, r.time_taken_ms, r.guesses, d.word
             FROM Results r
             LEFT JOIN Users u ON r.user_uuid = u.uuid
             LEFT JOIN DailyWords d ON d.id = r.game_id
             WHERE r.game_id = ? AND r.solved_successfully = 1
             ORDER BY
                r.guesses_taken ASC,
                (r.time_taken_ms IS NULL OR r.time_taken_ms = 0) ASC,
                r.time_taken_ms ASC
             LIMIT 10`
        ).bind(game_id).all();

        // `guesses` and `word` are dropped here: the response carries only the
        // derived pattern, never anything the answer can be read out of.
        const leaderboard = results.map(row => ({
            display_name: row.display_name,
            guesses_taken: row.guesses_taken,
            time_taken_ms: row.time_taken_ms,
            pattern: buildPattern(row.guesses, (row.word || '').toUpperCase())
        }));

        return new Response(JSON.stringify({ leaderboard }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('GET /api/dashboard/leaderboard failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to load leaderboard' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
