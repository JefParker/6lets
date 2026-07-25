import { getPuzzleNumber } from '../../lib/puzzle.js';

const MAX_DISPLAY_NAME_LENGTH = 24;

// Reject control characters and angle brackets. The dashboard escapes on render
// too — this is the second layer of defence, not the only one.
function hasDisallowedChars(str) {
    if (str.includes('<') || str.includes('>')) return true;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

function normalizeDisplayName(value) {
    if (value == null) return { ok: true, value: '' };
    if (typeof value !== 'string') return { ok: false };

    const trimmed = value.trim();
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return { ok: false };
    if (hasDisallowedChars(trimmed)) return { ok: false };

    return { ok: true, value: trimmed };
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const uuid = url.searchParams.get('uuid');
    const game_id = url.searchParams.get('game_id');

    if (!uuid) {
        return new Response(JSON.stringify({ error: 'Missing uuid' }), { status: 400 });
    }

    try {
        const { results } = await env.DB.prepare(`
            SELECT r.game_id, r.guesses_taken, r.solved_successfully, r.guesses, r.time_taken_ms, d.word
            FROM Results r
            JOIN DailyWords d ON r.game_id = d.id
            WHERE r.user_uuid = ?
            ORDER BY r.game_id DESC
        `).bind(uuid).all();

        let guessDistribution = [0,0,0,0,0,0,0,0,0,0];
        let completedGames = 0;
        let unfinishedGames = 0;
        let totalGuessesFinished = 0;
        let recentGames = [];
        let cloudGuesses = null;
        let cloudGameState = null;
        let cloudTimeTakenMs = null;
        let seenGameIds = new Set();

        for (const row of results) {
            if (seenGameIds.has(row.game_id)) {
                continue;
            }
            seenGameIds.add(row.game_id);

            if (game_id && row.game_id === game_id) {
                if (row.guesses) cloudGuesses = row.guesses;
                cloudGameState = row.solved_successfully === 1 ? 'won' : 'lost';
                if (row.time_taken_ms) cloudTimeTakenMs = row.time_taken_ms;
            }

            if (row.solved_successfully === 1) {
                completedGames++;
                totalGuessesFinished += row.guesses_taken;
                if (row.guesses_taken >= 1 && row.guesses_taken <= 10) {
                    guessDistribution[row.guesses_taken - 1]++;
                }
            } else {
                unfinishedGames++;
            }

            if (recentGames.length < 10) {
                const puzzleNum = getPuzzleNumber(row.game_id);
                if (puzzleNum !== null) {
                    const resultText = row.solved_successfully === 1 ? `${row.guesses_taken} guesses` : 'X guesses';
                    recentGames.push(`#${puzzleNum} ${row.word} - ${resultText}`);
                }
            }
        }

        const stats = {
            '6lets_distribution': JSON.stringify(guessDistribution),
            '6lets_completed': completedGames,
            '6lets_unfinished': unfinishedGames,
            '6lets_totalGuesses': totalGuessesFinished,
            '6lets_recentGames': JSON.stringify(recentGames)
        };

        const userRow = await env.DB.prepare('SELECT display_name FROM Users WHERE uuid = ?').bind(uuid).first();
        stats.display_name = userRow ? userRow.display_name || '' : '';

        if (cloudGameState) {
            stats.cloud_gameState = cloudGameState;
            stats.cloud_guesses = cloudGuesses;
            if (cloudTimeTakenMs) stats.cloud_timeTakenMs = cloudTimeTakenMs;
        }

        return new Response(JSON.stringify(stats), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('GET /api/user failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to load user' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const { uuid, display_name } = body;

        if (!uuid) return new Response(JSON.stringify({ error: 'Missing uuid' }), { status: 400 });

        const name = normalizeDisplayName(display_name);
        if (!name.ok) {
            return new Response(JSON.stringify({
                error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer and cannot contain < or >`
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        await env.DB.prepare(
            `INSERT INTO Users (uuid, display_name) VALUES (?, ?)
             ON CONFLICT(uuid) DO UPDATE SET display_name = excluded.display_name`
        ).bind(uuid, name.value).run();

        return new Response(JSON.stringify({ success: true, display_name: name.value }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('POST /api/user failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to save user' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
