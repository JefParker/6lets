// A D1-shaped wrapper around node:sqlite.
//
// Real SQLite, not a fake. That matters more than it might look: the session
// renewal rule — MIN(ceiling, MAX(current, wanted)) — lives *in SQL*, and a
// hand-written stub that recognised the query and reimplemented MIN/MAX in
// JavaScript would only ever be testing the stub. The whole point of the
// "renewal cannot pass the ceiling" case is to run that expression through an
// engine that did not learn it from the same author.
//
// node:sqlite ships with Node (22.5+) so this adds no dependency.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');

let DatabaseSync = null;
let importError = null;
try {
    ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
    importError = e;
}

export const sqliteAvailable = DatabaseSync !== null;

// ⚠ node:sqlite landed in Node 22.5 BEHIND --experimental-sqlite, and was only
// unflagged in 23.4. The flag requirement was never backported to 22.x, so a
// plain `node --test` on any Node 22 cannot load it.
//
// That matters more than a version note usually would, because it fails
// *quietly*: without the flag, the import throws, every database-backed test
// skips, `node --test` exits 0, and the pre-push hook prints a green tick —
// having run none of the sliding-expiry, ceiling-clamp, throttle or replay
// cases, which are the entire reason this suite exists. So `npm test` passes
// the flag (a harmless no-op on newer Node), and test/database.test.mjs fails
// loudly if it still is not there. Do not turn that into a skip.
export const dbSkip = !sqliteAvailable &&
    'node:sqlite unavailable — run via `npm test`, or Node 23.4+ / `node --test --experimental-sqlite`';

export function sqliteImportError() {
    return importError;
}

class Statement {
    constructor(db, sql, params = []) {
        this.db = db;
        this.sql = sql;
        this.params = params;
    }

    bind(...params) {
        // D1 returns a new bound statement rather than mutating; matching that
        // keeps call sites in lib/ portable between the two.
        return new Statement(this.db, this.sql, params);
    }

    async first() {
        const row = this.db.prepare(this.sql).get(...this.params);
        return row === undefined ? null : row;
    }

    async all() {
        return { results: this.db.prepare(this.sql).all(...this.params) };
    }

    async run() {
        const info = this.db.prepare(this.sql).run(...this.params);
        // `meta.changes` is the field consumeChallenge and deleteCredential
        // treat as the authoritative result of their guarded UPDATE/DELETE.
        return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }
        };
    }
}

class D1Like {
    constructor(db) {
        this.db = db;
    }

    prepare(sql) {
        return new Statement(this.db, sql);
    }
}

// Builds an in-memory database with the real migration applied — not a
// hand-copied CREATE TABLE. If the migration and the code disagree, these tests
// are where that shows up.
export function createTestDatabase() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(readFileSync(join(REPO_ROOT, 'migrations', '0001_admin_auth_and_sessions.sql'), 'utf8'));
    return { db, env: { DB: new D1Like(db) } };
}

export async function createTestAdmin(env, username = 'admin') {
    const id = crypto.randomUUID();
    await env.DB.prepare(
        'INSERT INTO AdminUsers (id, username, password_hash) VALUES (?, ?, ?)'
    ).bind(id, username, 'pbkdf2$sha256$1$AAAA$AAAA').run();
    return id;
}
