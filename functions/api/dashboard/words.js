async function verifyAuth(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;
    
    const cookies = cookieHeader.split(';').map(c => c.trim());
    const authCookie = cookies.find(c => c.startsWith('auth_token='));
    if (!authCookie) return false;

    const token = authCookie.substring('auth_token='.length);
    const [payload, signature] = token.split('.');
    
    try {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey('raw', encoder.encode(env.SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        
        const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload));

        if (!isValid) {
            console.log("verifyAuth failed: invalid signature");
            return false;
        }
        
        const decodedPayload = JSON.parse(atob(payload));
        if (decodedPayload.exp < Date.now()) {
            console.log("verifyAuth failed: token expired", decodedPayload.exp, Date.now());
            return false;
        }
        
        return true;
    } catch (e) {
        console.error("verifyAuth threw an error:", e);
        return false;
    }
}

export async function onRequestGet(context) {
    const { request, env } = context;
    if (!(await verifyAuth(request, env))) return new Response('Unauthorized', { status: 401 });
    
    const url = new URL(request.url);
    const date = url.searchParams.get('date'); // Format: YYYY-MM-DD
    
    if (!date) return new Response('Missing date', { status: 400 });

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
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    if (!(await verifyAuth(request, env))) return new Response('Unauthorized', { status: 401 });
    
    try {
        const { date, type, word } = await request.json(); // type is 'AM' or 'PM'
        const id = `${date}-${type}`;
        
        if (word) {
            // Check if word repeats within 2 years
            // The ID format is YYYY-MM-DD-AM. We can parse the year.
            const currentYear = parseInt(date.split('-')[0]);
            const pastYear = currentYear - 2;
            const pastDateString = `${pastYear}-${date.split('-').slice(1).join('-')}`;
            
            const checkQuery = await env.DB.prepare(
                "SELECT id FROM DailyWords WHERE word = ? AND id > ?"
            ).bind(word.toUpperCase(), pastDateString).first();

            if (checkQuery && checkQuery.id !== id) {
                return new Response(JSON.stringify({ error: `Word '${word}' was used recently on ${checkQuery.id}` }), { status: 400 });
            }

            // Insert or update
            await env.DB.prepare(
                "INSERT INTO DailyWords (id, word) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET word = excluded.word"
            ).bind(id, word.toUpperCase()).run();
        } else {
            // If empty, delete it
            await env.DB.prepare("DELETE FROM DailyWords WHERE id = ?").bind(id).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' }});
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
