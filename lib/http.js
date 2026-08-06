// Response helpers, matching the shape every existing route already returns:
// a JSON body with a `Content-Type: application/json` header.

export function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}

export function unauthorized() {
    return json({ error: 'Unauthorized' }, 401);
}

export function badRequest(message) {
    return json({ error: message }, 400);
}

export function serverError(message = 'Server error') {
    return json({ error: message }, 500);
}
