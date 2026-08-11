// /api/words — the two-tier word feed.
//
// Contract under test: the first PLAINTEXT_WINDOW scheduled half-days come
// back as { id, word: base64 } (old clients keep working), everything after
// as { id, sealed } with no plaintext anywhere; the array starts at the
// current game; and a missing SECRET_KEY degrades to plaintext-only instead
// of failing the endpoint the game boots from.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dbSkip } from './helpers/d1.mjs';
import { getCurrentGameId } from '../lib/puzzle.js';
import { unsealWord } from '../lib/wordseal.js';
import { onRequestGet } from '../functions/api/words.js';

// Successive half-day game ids starting from `id`, matching the AM/PM
// rollover the real ids follow.
function nextGameIds(startId, count) {
    const ids = [];
    let [y, m, d, half] = startId.split('-');
    let date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
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

async function seededEnv(scheduledHalfDays, secret = 'test-secret') {
    const { env } = createTestDatabase();
    const ids = nextGameIds(getCurrentGameId(), scheduledHalfDays);
    for (let i = 0; i < ids.length; i++) {
        // Distinct 6-letter words: WORDAA, WORDAB, ...
        const word = 'WORD' + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
        await env.DB.prepare('INSERT INTO DailyWords (id, word) VALUES (?, ?)').bind(ids[i], word).run();
    }
    if (secret) env.SECRET_KEY = secret;
    return { env, ids };
}

async function getPayload(env) {
    const res = await onRequestGet({ env });
    assert.equal(res.status, 200);
    return res.json();
}

test('plaintext window first, sealed tier after, starting at the current game', { skip: dbSkip }, async () => {
    const { env, ids } = await seededEnv(20);
    const payload = await getPayload(env);

    assert.equal(payload.length, 20);
    assert.equal(payload[0].id, ids[0]);

    const plain = payload.filter(e => e.word);
    const sealed = payload.filter(e => e.sealed);
    assert.equal(plain.length, 8);
    assert.equal(sealed.length, 12);
    // The tiers partition the array in order — no entry carries both forms.
    assert.ok(payload.slice(0, 8).every(e => e.word && !e.sealed));
    assert.ok(payload.slice(8).every(e => e.sealed && !e.word));

    assert.equal(atob(plain[0].word), 'WORDAA');
});

test('a sealed entry unseals to the scheduled word and leaks no plaintext', { skip: dbSkip }, async () => {
    const { env } = await seededEnv(10);
    const payload = await getPayload(env);

    const sealedEntry = payload[8];
    assert.ok(sealedEntry.sealed);
    const expected = 'WORDA' + String.fromCharCode(65 + 8); // 9th word: WORDAI
    assert.ok(!JSON.stringify(sealedEntry).includes(expected));
    assert.ok(!JSON.stringify(sealedEntry).includes(btoa(expected)));

    assert.equal(await unsealWord(sealedEntry.sealed), expected);
});

test('without SECRET_KEY the endpoint degrades to the plaintext tier alone', { skip: dbSkip }, async () => {
    const { env } = await seededEnv(20, null);
    const payload = await getPayload(env);

    assert.equal(payload.length, 8);
    assert.ok(payload.every(e => e.word && !e.sealed));
});

test('the window is capped even with months scheduled', { skip: dbSkip }, async () => {
    const { env } = await seededEnv(80);
    const payload = await getPayload(env);

    assert.equal(payload.length, 68); // 8 plaintext + 60 sealed
});
