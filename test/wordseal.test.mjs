// lib/wordseal.js — the sealed extended tier of /api/words.
//
// The property that matters: a sealed payload must be recoverable by the
// brute-force unseal (that is the entire offline feature) while never
// containing the word, its base64, or the full key (that is the entire point
// of sealing). public/script.js carries a copy of the unseal logic — if these
// tests pass and the browser can't unseal, the two copies have drifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sealWord, unsealWord, fromBase64, SEAL_BITS } from '../lib/wordseal.js';

const SECRET = 'test-secret-key';
const GAME_ID = '2026-08-11-PM';

test('seal/unseal roundtrip at production difficulty', async () => {
    const sealed = await sealWord('chests', GAME_ID, SECRET);

    const started = Date.now();
    const word = await unsealWord(sealed);
    const ms = Date.now() - started;

    assert.equal(word, 'CHESTS');
    // Not a hard bound — just surface the cost in the test output so a future
    // SEAL_BITS bump is a decision, not a surprise.
    console.log(`      unsealed ${SEAL_BITS}-bit seal in ${ms}ms`);
});

test('the sealed payload leaks neither the word nor the key', async () => {
    const sealed = await sealWord('CHESTS', GAME_ID, SECRET);
    const json = JSON.stringify(sealed);

    assert.ok(!json.includes('CHESTS'));
    assert.ok(!json.includes(btoa('CHESTS')));

    // The published partial key really has its low bits withheld.
    const partial = fromBase64(sealed.key);
    assert.equal(partial[31], 0);
    assert.equal(partial[30] & 0x7f, 0); // low 7 of the 15 withheld bits
});

test('different game ids seal under different keys', async () => {
    const a = await sealWord('CHESTS', '2026-08-11-PM', SECRET, 8);
    const b = await sealWord('CHESTS', '2026-08-12-AM', SECRET, 8);
    assert.notEqual(a.v, b.v);
    assert.notEqual(a.key, b.key);
});

test('a tampered ciphertext fails closed', async () => {
    const sealed = await sealWord('CHESTS', GAME_ID, SECRET, 8);
    const packed = fromBase64(sealed.ct);
    packed[packed.length - 1] ^= 0x01;
    let s = '';
    for (const byte of packed) s += String.fromCharCode(byte);
    const tampered = { ...sealed, ct: btoa(s) };

    // The key search still succeeds (verifier is intact) but AES-GCM refuses
    // the forged ciphertext.
    await assert.rejects(() => unsealWord(tampered));
});

test('a wrong verifier means no candidate matches', async () => {
    const sealed = await sealWord('CHESTS', GAME_ID, SECRET, 8);
    const wrong = { ...sealed, v: btoa(String.fromCharCode(...new Uint8Array(32))) };
    assert.equal(await unsealWord(wrong), null);
});

test('out-of-range bits are refused', async () => {
    await assert.rejects(() => sealWord('CHESTS', GAME_ID, SECRET, 4));
    await assert.rejects(() => sealWord('CHESTS', GAME_ID, SECRET, 24));
});
