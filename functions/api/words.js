import { getCurrentGameId } from '../../lib/puzzle.js';

export async function onRequestGet(context) {
    const { env } = context;

    const currentGameId = getCurrentGameId();

    // Only return a small look-ahead window (current game + next few half-days).
    // Enough to keep offline play working across a game rollover, without
    // exposing weeks of upcoming answers. NOTE: base64 below is obfuscation
    // only, NOT security — anyone can decode it, so the window must stay small.
    try {
        const { results } = await env.DB.prepare(
            "SELECT id, word FROM DailyWords WHERE id >= ? ORDER BY id ASC LIMIT 4"
        ).bind(currentGameId).all();

        // Encode words in base64 to obfuscate them
        const encodedResults = results.map(row => ({
            id: row.id,
            word: btoa(row.word) // Base64 encoding
        }));

        return new Response(JSON.stringify(encodedResults), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('GET /api/words failed:', e);
        // Never return 200 with an empty list here. The client caches whatever
        // this endpoint returns as its offline word list, so a 200 + [] on a
        // transient DB error would wipe a valid cache and drop every player
        // onto the offline fallback word. A 5xx makes the client keep its
        // last-known-good cache.
        return new Response(JSON.stringify({ error: 'Failed to load words' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
