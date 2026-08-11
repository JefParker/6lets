// Sealed future words for the extended offline window.
//
// /api/words serves two tiers: a small plaintext window (base64, same as
// always) and an extended window where each word is AES-GCM encrypted. The
// encryption key for game id G is SHA-256(SECRET_KEY | version | G) — cheap
// for the server, underivable for anyone without SECRET_KEY — and it is
// published WITH THE LOW `bits` BITS WITHHELD. The client recovers them by
// brute force: ~2^bits SHA-256 attempts checked against a published verifier
// hash, well under a second for one word, paid lazily only when that game
// becomes current.
//
// What this is and is not: the sealed tier is spoiler-proofing with a work
// factor, not secrecy. Anyone can run the same brute force per word — mining
// a month of answers costs them ~60 brute forces and deliberately written
// code, instead of curl piped through base64 -d. The integrity guard for the
// leaderboard is /api/results scoring guesses server-side, not this.
//
// The browser has its own copy of the unseal logic in public/script.js (it
// can't import ES modules from here without a build step) — keep the two in
// sync. unsealWord here is the reference implementation the tests exercise.

const VERSION = 'wordseal-v1';

// Withheld-bits count. 8..16 only: the brute-force loop varies the low two
// key bytes, and below 8 the zeroed byte would exceed the search space.
// 15 bits ≈ 33k hashes ≈ a fraction of a second in WebCrypto.
export const SEAL_BITS = 15;

const te = new TextEncoder();

export function toBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function fromBase64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function deriveKey(secret, gameId) {
    return sha256(te.encode(`${secret}|${VERSION}|${gameId}`));
}

export async function sealWord(word, gameId, secret, bits = SEAL_BITS) {
    if (!Number.isInteger(bits) || bits < 8 || bits > 16) {
        throw new Error(`sealWord: bits must be 8..16, got ${bits}`);
    }

    const K = await deriveKey(secret, gameId);
    const verifier = await sha256(K);

    const partial = new Uint8Array(K);
    partial[31] = 0;
    if (bits > 8) partial[30] &= (0xff << (bits - 8)) & 0xff;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', K, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(word.toUpperCase()))
    );

    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv, 0);
    packed.set(ct, iv.length);

    return { key: toBase64(partial), bits, v: toBase64(verifier), ct: toBase64(packed) };
}

// Reference unseal: recover the withheld bits by brute force, then decrypt.
// Returns the word, or null if no candidate key matches the verifier.
// A matched verifier with a failing decrypt (tampered ciphertext) throws.
export async function unsealWord(sealed) {
    const partial = fromBase64(sealed.key);
    const verifier = fromBase64(sealed.v);
    const packed = fromBase64(sealed.ct);
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);

    const max = 1 << sealed.bits;
    const cand = new Uint8Array(partial);
    for (let v = 0; v < max; v++) {
        cand[31] = v & 0xff;
        if (sealed.bits > 8) cand[30] = partial[30] | ((v >> 8) & 0xff);

        const h = await sha256(cand);
        let match = true;
        for (let i = 0; i < 32; i++) {
            if (h[i] !== verifier[i]) { match = false; break; }
        }
        if (!match) continue;

        const key = await crypto.subtle.importKey('raw', cand, 'AES-GCM', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(plain);
    }
    return null;
}
