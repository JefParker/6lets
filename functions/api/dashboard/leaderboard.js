export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const game_id = url.searchParams.get('game_id');
    
    if (!game_id) {
        return new Response(JSON.stringify({ error: 'Missing game_id parameter' }), { status: 400 });
    }
    
    try {
        const { results } = await env.DB.prepare(
            `SELECT u.display_name, r.guesses_taken, r.time_taken_ms 
             FROM Results r 
             LEFT JOIN Users u ON r.user_uuid = u.uuid 
             WHERE r.game_id = ? AND r.solved_successfully = 1 
             ORDER BY 
                r.guesses_taken ASC, 
                (r.time_taken_ms IS NULL OR r.time_taken_ms = 0) ASC, 
                r.time_taken_ms ASC 
             LIMIT 10`
        ).bind(game_id).all();
        
        return new Response(JSON.stringify({ leaderboard: results }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
