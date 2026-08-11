import { GAME_ID_PATTERN } from '../../lib/puzzle.js';

const MAX_BATCH_RECORDS = 100;
const MAX_GUESSES = 10;
const WORD_LENGTH = 6;
// Generous ceiling (24h) — just enough to reject nonsense that would wreck the
// leaderboard sort, not a real anti-cheat measure.
const MAX_TIME_TAKEN_MS = 24 * 60 * 60 * 1000;
const MAX_GUESSES_BLOB_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidRecord(res) {
    if (!res || typeof res !== 'object') return false;
    if (typeof res.user_uuid !== 'string' || !UUID_PATTERN.test(res.user_uuid)) return false;
    if (typeof res.game_id !== 'string' || !GAME_ID_PATTERN.test(res.game_id)) return false;

    const guessesTaken = Number(res.guesses_taken);
    if (!Number.isInteger(guessesTaken) || guessesTaken < 1 || guessesTaken > MAX_GUESSES) return false;

    const timeTakenMs = Number(res.time_taken_ms);
    if (!Number.isFinite(timeTakenMs) || timeTakenMs < 0 || timeTakenMs > MAX_TIME_TAKEN_MS) return false;

    if (res.guesses != null &&
        (typeof res.guesses !== 'string' || res.guesses.length > MAX_GUESSES_BLOB_LENGTH)) {
        return false;
    }

    return true;
}

// null: no blob (older clients). false: a blob that is present but malformed —
// the record should be dropped, not stored, because the leaderboard scores
// these blobs into grids. Otherwise: the guesses, uppercased.
function parseGuessesBlob(blob) {
    if (blob == null) return null;

    let parsed;
    try {
        parsed = JSON.parse(blob);
    } catch (e) {
        return false;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_GUESSES) return false;
    for (const guess of parsed) {
        if (typeof guess !== 'string' || guess.length !== WORD_LENGTH) return false;
    }
    return parsed.map(g => g.toUpperCase());
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const payload = await request.json();

        let resultsArray = [];
        if (Array.isArray(payload)) {
            resultsArray = payload;
        } else if (payload && Array.isArray(payload.pending)) {
            resultsArray = payload.pending;
        }

        resultsArray = resultsArray.slice(0, MAX_BATCH_RECORDS);

        if (resultsArray.length === 0) {
            return new Response(JSON.stringify({ success: true, accepted: 0, skipped: 0 }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Validate first, then check that each game_id actually exists in
        // DailyWords. Results has a FK to DailyWords(id) and D1 enforces FKs,
        // so an unknown game_id would abort the whole (atomic) batch. Because
        // the client clears its queue on any 2xx, one such record used to jam
        // syncing forever — so bad records are dropped here rather than fataled.
        const candidates = resultsArray.filter(isValidRecord);
        let skipped = resultsArray.length - candidates.length;

        // The words come along with the ids so solved_successfully can be
        // derived below instead of trusted.
        let wordsByGameId = new Map();
        if (candidates.length > 0) {
            const uniqueGameIds = [...new Set(candidates.map(c => c.game_id))];
            const placeholders = uniqueGameIds.map(() => '?').join(',');
            const { results: known } = await env.DB.prepare(
                `SELECT id, word FROM DailyWords WHERE id IN (${placeholders})`
            ).bind(...uniqueGameIds).all();
            wordsByGameId = new Map(known.map(row => [row.id, String(row.word).toUpperCase()]));
        }

        const stmt = env.DB.prepare(
            `INSERT INTO Results (id, user_uuid, game_id, guesses_taken, time_taken_ms, solved_successfully, guesses)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_uuid, game_id) DO UPDATE SET
                guesses_taken = excluded.guesses_taken,
                time_taken_ms = CASE WHEN excluded.time_taken_ms > 0 THEN excluded.time_taken_ms ELSE time_taken_ms END,
                solved_successfully = excluded.solved_successfully,
                guesses = excluded.guesses,
                played_at = CURRENT_TIMESTAMP`
        );

        // Ensure users exist (Upsert logic for SQLite)
        const userStmt = env.DB.prepare(
            "INSERT INTO Users (uuid) VALUES (?) ON CONFLICT(uuid) DO NOTHING"
        );

        const batch = [];
        let accepted = 0;
        for (const res of candidates) {
            if (!wordsByGameId.has(res.game_id)) {
                skipped++;
                continue;
            }

            const parsedGuesses = parseGuessesBlob(res.guesses);
            if (parsedGuesses === false) {
                skipped++;
                continue;
            }

            // When the guesses are present, score them here rather than
            // believing the client's flag. A client that never learned the
            // real word plays against its offline fallback and honestly
            // reports a "win" its guesses contradict — which the leaderboard
            // then renders as a solved row with a grid that never turns green,
            // since grids are scored server-side against the real word. The
            // same derivation covers guesses_taken, so a short count can't be
            // claimed for a long game. Blob-less records (older clients) keep
            // the client's values.
            let solved = res.solved_successfully ? 1 : 0;
            let guessesTaken = Number(res.guesses_taken);
            if (parsedGuesses) {
                solved = parsedGuesses[parsedGuesses.length - 1] === wordsByGameId.get(res.game_id) ? 1 : 0;
                guessesTaken = parsedGuesses.length;
            }

            batch.push(userStmt.bind(res.user_uuid)); // Ensure user exists
            batch.push(stmt.bind(
                crypto.randomUUID(), // Generate new UUID for the result record
                res.user_uuid,
                res.game_id,
                guessesTaken,
                Number(res.time_taken_ms),
                solved,
                res.guesses || null
            ));
            accepted++;
        }

        // Execute batch operations
        if (batch.length > 0) {
            await env.DB.batch(batch);
        }

        // A 2xx here means "everything we could process, we did" — the client
        // is safe to clear its queue. Only a 5xx (below) should make it retry.
        return new Response(JSON.stringify({ success: true, accepted, skipped }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        // Real cause to the server log; generic message to the client.
        console.error('POST /api/results failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to save results' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
