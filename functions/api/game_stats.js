export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const game_id = url.searchParams.get('game_id');
    
    if (!game_id) {
        return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400 });
    }
    
    try {
        const { results } = await env.DB.prepare(
            "SELECT guesses_taken, solved_successfully, COUNT(DISTINCT user_uuid) as count FROM Results WHERE game_id = ? GROUP BY guesses_taken, solved_successfully"
        ).bind(game_id).all();
        
        let distribution = Array(11).fill(0);
        let total = 0;
        
        for (const row of results) {
            total += row.count;
            if (row.solved_successfully === 1) {
                if (row.guesses_taken >= 1 && row.guesses_taken <= 10) {
                    distribution[row.guesses_taken - 1] += row.count;
                }
            } else {
                distribution[10] += row.count;
            }
        }
        
        return new Response(JSON.stringify({ distribution, total }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
