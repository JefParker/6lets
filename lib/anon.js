// Unnamed players on the leaderboard show as "Anonymous-244": "Anonymous"
// plus the last part of their first IP address seen (PlayerTags,
// migrations/0003_player_tags.sql). The same helpers live in jeff-parker.com's
// lib/validate.js, whose copy of 6Lets shares this database; keep them in step.

/**
 * The last number of an IPv4 address ("244"), the last group of an IPv6 one
 * ("3f2a"). Only this part is ever kept, never the whole address. '' when
 * there's none.
 */
export function ipTag(request) {
    // A missing tag must never stop a score being saved.
    const ip = String((request && request.headers && request.headers.get('CF-Connecting-IP')) || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return String(Number(ip.split('.')[3]));
    if (ip.includes(':')) {
        const last = ip.split(':').pop();
        return /^[0-9a-f]{1,4}$/i.test(last) ? last.toLowerCase().replace(/^0+(?=.)/, '') : '';
    }
    return '';
}

/** The player's own name, or "Anonymous-<tag>" when they haven't given one. */
export function boardName(name, tag) {
    if (name && name !== 'Anonymous') return name;
    return tag ? 'Anonymous-' + tag : 'Anonymous';
}
