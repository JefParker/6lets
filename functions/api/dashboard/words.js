import { verifyAuth } from '../../../lib/auth.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WORD_PATTERN = /^[A-Z]{6}$/;

function unauthorized() {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestGet(context) {
    const { request, env } = context;
    if (!(await verifyAuth(request, env))) return unauthorized();

    const url = new URL(request.url);
    const date = url.searchParams.get('date'); // Format: YYYY-MM-DD

    if (!date || !DATE_PATTERN.test(date)) {
        return new Response(JSON.stringify({ error: 'Invalid or missing date' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const { results } = await env.DB.prepare(
            "SELECT id, word FROM DailyWords WHERE id LIKE ?"
        ).bind(`${date}-%`).all();

        const { results: countResults } = await env.DB.prepare(
            "SELECT game_id, COUNT(DISTINCT user_uuid) as count FROM Results WHERE game_id LIKE ? GROUP BY game_id"
        ).bind(`${date}-%`).all();

        const words = {
            AM: { word: '', count: 0 },
            PM: { word: '', count: 0 }
        };

        results.forEach(row => {
            if (row.id.endsWith('-AM')) words.AM.word = row.word;
            if (row.id.endsWith('-PM')) words.PM.word = row.word;
        });

        countResults.forEach(row => {
            if (row.game_id.endsWith('-AM')) words.AM.count = row.count;
            if (row.game_id.endsWith('-PM')) words.PM.count = row.count;
        });

        return new Response(JSON.stringify(words), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error('GET /api/dashboard/words failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to load words' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    if (!(await verifyAuth(request, env))) return unauthorized();

    try {
        const { date, type, word } = await request.json(); // type is 'AM' or 'PM'

        if (!date || !DATE_PATTERN.test(date)) {
            return new Response(JSON.stringify({ error: 'Invalid date' }), {
                status: 400, headers: { 'Content-Type': 'application/json' }
            });
        }
        if (type !== 'AM' && type !== 'PM') {
            return new Response(JSON.stringify({ error: 'Type must be AM or PM' }), {
                status: 400, headers: { 'Content-Type': 'application/json' }
            });
        }

        const id = `${date}-${type}`;

        if (word) {
            const normalized = String(word).trim().toUpperCase();

            // A word outside A-Z (digits, punctuation, wrong length) produces an
            // unwinnable puzzle: the client rejects it as "Not in word list", so
            // the answer can never be entered.
            if (!WORD_PATTERN.test(normalized)) {
                return new Response(JSON.stringify({ error: 'Word must be exactly 6 letters (A-Z)' }), {
                    status: 400, headers: { 'Content-Type': 'application/json' }
                });
            }

            // Check the word hasn't been used in roughly the last 2 years.
            // Excluding the row being edited in SQL (rather than comparing a
            // single arbitrary `.first()` result afterwards) means a genuine
            // collision on some *other* date can't slip through.
            const currentYear = parseInt(date.split('-')[0], 10);
            const pastDateString = `${currentYear - 2}-${date.split('-').slice(1).join('-')}`;

            const clash = await env.DB.prepare(
                "SELECT id FROM DailyWords WHERE word = ? AND id > ? AND id != ? ORDER BY id DESC LIMIT 1"
            ).bind(normalized, pastDateString, id).first();

            if (clash) {
                return new Response(JSON.stringify({ error: `Word '${normalized}' was used recently on ${clash.id}` }), {
                    status: 400, headers: { 'Content-Type': 'application/json' }
                });
            }

            await env.DB.prepare(
                "INSERT INTO DailyWords (id, word) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET word = excluded.word"
            ).bind(id, normalized).run();
        } else {
            // If empty, delete it
            await env.DB.prepare("DELETE FROM DailyWords WHERE id = ?").bind(id).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        console.error('POST /api/dashboard/words failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to save word' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
