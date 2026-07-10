export async function onRequestGet(context) {
    const { env } = context;
    
    // Get current LA game ID (e.g. 2026-07-08-AM)
    const options = { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    let year, month, day, hour;
    for (const part of parts) {
        if (part.type === 'year') year = part.value;
        if (part.type === 'month') month = part.value;
        if (part.type === 'day') day = part.value;
        if (part.type === 'hour') hour = parseInt(part.value, 10);
    }
    const ampm = hour < 12 ? 'AM' : 'PM';
    const currentGameId = `${year}-${month}-${day}-${ampm}`;

    // Get the next 120 words (60 days * 2)
    try {
        const { results } = await env.DB.prepare(
            "SELECT id, word FROM DailyWords WHERE id >= ? ORDER BY id ASC LIMIT 120"
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
        return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
