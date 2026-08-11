import { verifyAuth } from '../../../lib/auth.js';
import { runwayStatus } from '../../../lib/runway.js';

// How much schedule is left, for the dashboard's runway indicator: contiguous
// days of words from the current game, plus how many pool candidates remain
// for the automatic top-up to draw on.
export async function onRequestGet(context) {
    const { request, env } = context;
    if (!(await verifyAuth(request, env))) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const status = await runwayStatus(env);
        return new Response(JSON.stringify(status), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('GET /api/dashboard/runway failed:', e);
        return new Response(JSON.stringify({ error: 'Failed to load runway' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
