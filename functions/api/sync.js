export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const user_uuid = url.searchParams.get('user_uuid');
    
    if (!user_uuid) {
        return new Response(JSON.stringify({ error: 'Missing user_uuid' }), { status: 400 });
    }
    
    try {
        const result = await env.DB.prepare(
            "SELECT stats, history, total_games FROM UserState WHERE user_uuid = ?"
        ).bind(user_uuid).first();
        
        if (result) {
            return new Response(JSON.stringify({
                found: true,
                stats: JSON.parse(result.stats || '[]'),
                history: JSON.parse(result.history || '[]'),
                total_games: result.total_games
            }), { headers: { 'Content-Type': 'application/json' } });
        } else {
            return new Response(JSON.stringify({ found: false }), { headers: { 'Content-Type': 'application/json' } });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const payload = await request.json();
        const { user_uuid, stats, history, total_games } = payload;
        
        if (!user_uuid || typeof total_games !== 'number') {
            return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
        }
        
        // Ensure user exists
        await env.DB.prepare("INSERT INTO Users (uuid) VALUES (?) ON CONFLICT(uuid) DO NOTHING").bind(user_uuid).run();

        // Check current DB state
        const current = await env.DB.prepare("SELECT total_games FROM UserState WHERE user_uuid = ?").bind(user_uuid).first();
        
        if (!current || total_games > current.total_games) {
            await env.DB.prepare(
                "INSERT INTO UserState (user_uuid, stats, history, total_games) VALUES (?, ?, ?, ?) ON CONFLICT(user_uuid) DO UPDATE SET stats = excluded.stats, history = excluded.history, total_games = excluded.total_games"
            ).bind(
                user_uuid,
                JSON.stringify(stats || []),
                JSON.stringify(history || []),
                total_games
            ).run();
            return new Response(JSON.stringify({ success: true, updated: true }), { headers: { 'Content-Type': 'application/json' } });
        } else {
            return new Response(JSON.stringify({ success: true, updated: false, message: 'DB has newer or equal state' }), { headers: { 'Content-Type': 'application/json' } });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
