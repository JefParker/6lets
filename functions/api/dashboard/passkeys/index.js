import { requireAdminSession } from '../../../../lib/auth.js';
import { json, serverError, unauthorized } from '../../../../lib/http.js';
import { listCredentials } from '../../../../lib/passkeys.js';

// The management list. Never returns public_key — nothing on the client needs
// it, and an endpoint that hands out credential material by default is how it
// ends up somewhere it shouldn't be.
export async function onRequestGet(context) {
    const { request, env } = context;

    const session = await requireAdminSession(request, env);
    if (!session) return unauthorized();

    try {
        const credentials = await listCredentials(env, session.user_id);

        return json({
            passkeys: credentials.map(c => ({
                id: c.id,
                nickname: c.nickname,
                createdAt: c.created_at,
                lastUsedAt: c.last_used_at
            }))
        });
    } catch (e) {
        console.error('GET /api/dashboard/passkeys failed:', e);
        return serverError('Could not load passkeys');
    }
}
