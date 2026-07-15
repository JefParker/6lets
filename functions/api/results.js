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

        if (resultsArray.length === 0) {
            return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
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
        for (const res of resultsArray) {
            batch.push(userStmt.bind(res.user_uuid)); // Ensure user exists
            batch.push(stmt.bind(
                crypto.randomUUID(), // Generate new UUID for the result record
                res.user_uuid,
                res.game_id,
                res.guesses_taken,
                res.time_taken_ms,
                res.solved_successfully ? 1 : 0,
                res.guesses || null
            ));
        }

        // Execute batch operations
        await env.DB.batch(batch);

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
