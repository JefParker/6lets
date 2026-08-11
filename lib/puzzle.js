// Shared puzzle-identity helpers for the Cloudflare Functions runtime.
// The browser has its own copy of this logic in public/script.js (it can't
// import ES modules from here without a build step) — keep the two in sync.

export const PUZZLE_EPOCH_NUMBER = 3298;
export const PUZZLE_EPOCH_YEAR = 2026;
export const PUZZLE_EPOCH_MONTH = 6; // 0-indexed: July
export const PUZZLE_EPOCH_DAY = 8;

export const GAME_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(AM|PM)$/;

// Current game id in Los Angeles time, e.g. '2026-07-08-AM'.
//
// NOTE: `hour12: false` is deliberately NOT used. It selects hour cycle h24 in
// several engines, which formats midnight as "24" rather than "00" — that reads
// as >= 12 and would serve the PM word during the first hour of the AM puzzle.
// `hourCycle: 'h23'` is unambiguous.
export function getCurrentGameId(now = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
    });

    let year, month, day, hour;
    for (const part of formatter.formatToParts(now)) {
        if (part.type === 'year') year = part.value;
        if (part.type === 'month') month = part.value;
        if (part.type === 'day') day = part.value;
        if (part.type === 'hour') hour = parseInt(part.value, 10);
    }

    // Belt and braces in case an engine still hands back h24.
    if (hour === 24) hour = 0;

    return `${year}-${month}-${day}-${hour < 12 ? 'AM' : 'PM'}`;
}

// The `count` successive half-day game ids starting at (and including)
// `startId`, following the AM→PM→next-day-AM rollover.
export function nextGameIds(startId, count) {
    const ids = [];
    let [year, month, day, half] = startId.split('-');
    let date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    for (let i = 0; i < count; i++) {
        const yy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        ids.push(`${yy}-${mm}-${dd}-${half}`);
        if (half === 'AM') {
            half = 'PM';
        } else {
            half = 'AM';
            date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
        }
    }
    return ids;
}

// Puzzle number for a game id. Returns null for anything malformed so callers
// can decide what to do rather than silently getting NaN or a wrong number.
export function getPuzzleNumber(gameIdStr) {
    if (typeof gameIdStr !== 'string' || !GAME_ID_PATTERN.test(gameIdStr)) return null;

    const [year, month, day, ampm] = gameIdStr.split('-');
    const puzzleDate = Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    const epochDate = Date.UTC(PUZZLE_EPOCH_YEAR, PUZZLE_EPOCH_MONTH, PUZZLE_EPOCH_DAY);
    const diffDays = Math.round((puzzleDate - epochDate) / (1000 * 60 * 60 * 24));

    return PUZZLE_EPOCH_NUMBER + (diffDays * 2) + (ampm === 'AM' ? 0 : 1);
}
