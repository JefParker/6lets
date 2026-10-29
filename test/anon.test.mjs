// Unnamed players show on the leaderboard as "Anonymous-<last part of their
// IP>", taken from the first result they send and kept after that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dbSkip } from './helpers/d1.mjs';
import { onRequestPost } from '../functions/api/results.js';
import { onRequestGet } from '../functions/api/dashboard/leaderboard.js';
import { ipTag, boardName } from '../lib/anon.js';

const GAME_ID = '2026-08-11-AM';
const UUID = '11111111-1111-4111-8111-111111111111';

function post(env, ip) {
    return onRequestPost({
        env,
        request: {
            headers: new Headers({ 'CF-Connecting-IP': ip }),
            json: async () => [{
                user_uuid: UUID, game_id: GAME_ID, guesses_taken: 3, time_taken_ms: 60000,
                solved_successfully: true, guesses: JSON.stringify(['STAPLE', 'PHRASE', 'PHASES'])
            }]
        }
    });
}

async function boardNames(env) {
    const res = await onRequestGet({ env, request: new Request('https://6lets.com/api/dashboard/leaderboard?game_id=' + GAME_ID) });
    return (await res.json()).leaderboard.map(row => row.display_name);
}

test('ipTag keeps only the last part of the address', () => {
    const req = ip => ({ headers: new Headers(ip ? { 'CF-Connecting-IP': ip } : {}) });
    assert.equal(ipTag(req('98.7.6.244')), '244');
    assert.equal(ipTag(req('2600:1700:abc::03f2')), '3f2');
    assert.equal(ipTag(req('')), '');
    assert.equal(ipTag({}), '');
});

test('boardName keeps a real name and tags the rest', () => {
    assert.equal(boardName('Ron', '5'), 'Ron');
    assert.equal(boardName('', '244'), 'Anonymous-244');
    assert.equal(boardName(null, ''), 'Anonymous');
});

test('an unnamed player is listed as Anonymous-<tag>, and the first tag stays', { skip: dbSkip }, async () => {
    const { env } = createTestDatabase();
    await env.DB.prepare('INSERT INTO DailyWords (id, word) VALUES (?, ?)').bind(GAME_ID, 'PHASES').run();
    await post(env, '98.7.6.244');
    assert.deepEqual(await boardNames(env), ['Anonymous-244']);
    await post(env, '10.0.0.9');
    assert.deepEqual(await boardNames(env), ['Anonymous-244']);
});
