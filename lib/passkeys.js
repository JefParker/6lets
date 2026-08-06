// Database-side of the passkey ceremonies: challenge lifecycle and credential
// storage. The crypto lives in lib/webauthn.js, which touches no database and
// can therefore be tested against a synthetic authenticator on its own.

import { isoSeconds } from './auth.js';
import { CeremonyError, randomChallenge } from './webauthn.js';

// Long enough for a user to find their phone, short enough that a captured
// challenge is worthless by the time anyone gets to it.
export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

export const CHALLENGE_REGISTRATION = 'registration';
export const CHALLENGE_AUTHENTICATION = 'authentication';

export async function issueChallenge(env, purpose, userId = null, { now = Date.now() } = {}) {
    const challenge = randomChallenge();

    await env.DB.prepare(
        'INSERT INTO AdminChallenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(challenge, purpose, userId, isoSeconds(now + CHALLENGE_TTL_SECONDS * 1000)).run();

    // Opportunistic sweep. Challenges are worthless once expired and there is
    // no separate cleanup job; doing it on issue keeps the table from growing
    // without adding a scheduled worker.
    await env.DB.prepare('DELETE FROM AdminChallenges WHERE expires_at <= ?')
        .bind(isoSeconds(now)).run();

    return challenge;
}

// Single-use challenges are the entire anti-replay story, so this has to be
// airtight in two separate ways.
//
// (1) CONSUME BEFORE VERIFYING, not after. It is tempting to verify the
//     signature first and only mark the challenge used on success — that reads
//     as "don't burn a challenge on a typo". It means a captured assertion can
//     be retried indefinitely for as long as its challenge is live, because
//     every failed attempt leaves the challenge exactly as it found it. The
//     callers in functions/api/dashboard/passkeys/ call this first and verify
//     afterwards; keep it that way.
//
// (2) THE CONSUMING UPDATE IS THE GUARD, not a SELECT before it. Two requests
//     replaying the same challenge both pass a `SELECT ... WHERE consumed_at IS
//     NULL`, because neither has written anything yet when the other reads.
//     Only one of them can change a row. So the atomic UPDATE below is the
//     check, and `meta.changes === 1` is its result — never re-read the row to
//     "confirm" it.
//
// `purpose` is matched here as well, which is what stops a registration
// challenge being redeemed as a sign-in.
export async function consumeChallenge(env, challenge, purpose, { now = Date.now() } = {}) {
    if (typeof challenge !== 'string' || challenge.length === 0) {
        throw new CeremonyError('no challenge presented');
    }

    const nowIso = isoSeconds(now);

    const result = await env.DB.prepare(
        `UPDATE AdminChallenges
            SET consumed_at = ?
          WHERE challenge = ?
            AND purpose = ?
            AND consumed_at IS NULL
            AND expires_at > ?`
    ).bind(nowIso, challenge, purpose, nowIso).run();

    if (!result.meta || result.meta.changes !== 1) {
        // Covers all four cases at once — unknown, already spent, expired, or
        // issued for the other ceremony — and deliberately does not say which.
        throw new CeremonyError('challenge is unknown, expired, or already used');
    }

    // Safe to read now: this request owns the row, having been the one that
    // changed it.
    return env.DB.prepare(
        'SELECT challenge, purpose, user_id FROM AdminChallenges WHERE challenge = ?'
    ).bind(challenge).first();
}

// --------------------------------------------------------- credentials -----

export async function listCredentials(env, userId) {
    const { results } = await env.DB.prepare(
        `SELECT id, credential_id, nickname, transports, created_at, last_used_at
           FROM AdminCredentials
          WHERE user_id = ?
          ORDER BY created_at ASC`
    ).bind(userId).all();
    return results || [];
}

export async function findCredentialById(env, credentialId) {
    return env.DB.prepare(
        `SELECT id, user_id, credential_id, public_key, algorithm, sign_count
           FROM AdminCredentials
          WHERE credential_id = ?`
    ).bind(credentialId).first();
}

export async function insertCredential(env, {
    userId, credentialId, publicKey, algorithm, signCount, nickname, transports
}) {
    await env.DB.prepare(
        `INSERT INTO AdminCredentials
             (id, user_id, credential_id, public_key, algorithm, sign_count, nickname, transports, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        crypto.randomUUID(), userId, credentialId, publicKey, algorithm,
        signCount, nickname, transports ? JSON.stringify(transports) : null, isoSeconds()
    ).run();
}

// Recorded, never compared. See the note at the end of verifyAssertion: every
// syncing credential provider reports 0 forever by design, so enforcing that
// this only ever increases would lock out the common case while detecting
// nothing. It is stored because it costs nothing and is occasionally useful
// when reading logs after the fact.
export async function recordCredentialUse(env, credentialId, signCount, { now = Date.now() } = {}) {
    await env.DB.prepare(
        'UPDATE AdminCredentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?'
    ).bind(signCount, isoSeconds(now), credentialId).run();
}

export async function deleteCredential(env, userId, id) {
    // Scoped to the owner so a valid session cannot delete another admin's
    // credential by guessing an id.
    const result = await env.DB.prepare(
        'DELETE FROM AdminCredentials WHERE id = ? AND user_id = ?'
    ).bind(id, userId).run();
    return !!result.meta && result.meta.changes === 1;
}
