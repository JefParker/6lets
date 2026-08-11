import { getCurrentGameId } from '../../lib/puzzle.js';
import { sealWord } from '../../lib/wordseal.js';
import { ensureRunway } from '../../lib/runway.js';

// Two tiers, one array:
//
//   { id, word }    — plaintext tier (base64): the current game plus the next
//                     few half-days. base64 is obfuscation only, NOT security;
//                     everything in this tier is effectively published, so it
//                     stays small.
//   { id, sealed }  — extended tier: up to ~30 further days, AES-GCM sealed
//                     with a partially-withheld key (see lib/wordseal.js).
//                     Reading one costs a deliberate ~2^15-hash brute force,
//                     so casual curl+base64 no longer spoils the schedule and
//                     a synced device can keep playing offline for weeks.
//
// Both tiers can only serve rows that exist: the window is really
// min(configured window, how far ahead words are scheduled). Note `id >= ?`
// skips a missing current word — if today's row was never entered, clients get
// only future ids and (correctly) refuse to start a game rather than fall
// back to the offline word.
const PLAINTEXT_WINDOW = 8;
const SEALED_WINDOW = 60;

export async function onRequestGet(context) {
    const { env } = context;

    const currentGameId = getCurrentGameId();

    try {
        // Keep the schedule at the 40-day floor before reading it, so a
        // top-up is reflected in this very response. Failure here must never
        // take down the feed the game boots from — the dashboard's runway
        // indicator is where a struggling top-up becomes visible.
        try {
            await ensureRunway(env);
        } catch (e) {
            console.error('ensureRunway failed:', e);
        }

        const { results } = await env.DB.prepare(
            "SELECT id, word FROM DailyWords WHERE id >= ? ORDER BY id ASC LIMIT ?"
        ).bind(currentGameId, PLAINTEXT_WINDOW + SEALED_WINDOW).all();

        const payload = results.slice(0, PLAINTEXT_WINDOW).map(row => ({
            id: row.id,
            word: btoa(row.word)
        }));

        // No SECRET_KEY (mis-set environment) degrades to the plaintext tier
        // alone rather than failing the endpoint the game depends on.
        if (env.SECRET_KEY) {
            for (const row of results.slice(PLAINTEXT_WINDOW)) {
                payload.push({
                    id: row.id,
                    sealed: await sealWord(row.word, row.id, env.SECRET_KEY)
                });
            }
        }

        return new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('GET /api/words failed:', e);
        // Never return 200 with an empty list here. The client caches whatever
        // this endpoint returns as its offline word list, so a 200 + [] on a
        // transient DB error would wipe a valid cache and drop every player
        // onto the retry panel. A 5xx makes the client keep its
        // last-known-good cache.
        return new Response(JSON.stringify({ error: 'Failed to load words' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
