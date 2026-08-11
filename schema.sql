-- schema.sql
--
-- Safe to run against any environment, including production: it only creates
-- what is missing. The destructive DROP TABLE statements that used to live here
-- have moved to reset.sql — one stray `--remote` run of this file used to wipe
-- every player's history.

CREATE TABLE IF NOT EXISTS Users (
    uuid TEXT PRIMARY KEY,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS DailyWords (
    id TEXT PRIMARY KEY, -- e.g., '2026-07-08-AM'
    word TEXT NOT NULL
);

-- Curated answer candidates for the automatic schedule top-up. Seeded via
-- regenerate-words.py --emit-pool; drawn from by lib/runway.js when the
-- runway drops below the 40-day floor. A candidate is available while it
-- appears nowhere in DailyWords — availability is derived, never stored.
-- (Also in migrations/0002_answer_pool.sql, the file that reached production.)
CREATE TABLE IF NOT EXISTS AnswerPool (
    word TEXT PRIMARY KEY CHECK (length(word) = 6)
);

CREATE TABLE IF NOT EXISTS Results (
    id TEXT PRIMARY KEY, -- e.g. UUID for the result itself
    user_uuid TEXT NOT NULL,
    game_id TEXT NOT NULL,
    guesses_taken INTEGER NOT NULL,
    time_taken_ms INTEGER NOT NULL,
    solved_successfully BOOLEAN NOT NULL,
    guesses TEXT,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_uuid) REFERENCES Users(uuid),
    FOREIGN KEY (game_id) REFERENCES DailyWords(id),
    UNIQUE(user_uuid, game_id)
);

-- NOTE: The former UserState table has been removed. Aggregate per-user stats
-- are derived on demand from the Results table (see functions/api/user.js),
-- so a separate stats/history store is no longer needed.

-- Leaderboard and per-puzzle stats both filter on game_id, which is not a
-- leftmost prefix of any existing index.
CREATE INDEX IF NOT EXISTS idx_results_game_id ON Results(game_id);

-- REQUIRED, not an optimisation. /api/results inserts with
-- `ON CONFLICT(user_uuid, game_id) DO UPDATE`, and SQLite rejects a conflict
-- target that no uniqueness constraint covers — every insert throws
-- "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
--
-- The UNIQUE(user_uuid, game_id) declared in the CREATE TABLE above only ever
-- reaches a database that this file *created*. Production's Results table
-- predates that line, and CREATE TABLE IF NOT EXISTS silently skips an existing
-- table, so production has never had the constraint — verified 2026-07-26 with
-- PRAGMA index_list('Results'), which returned no row with origin='u'.
--
-- On 2026-07-25 this index was dropped as "redundant with the constraint".
-- Production had no constraint to be redundant with, so every POST /api/results
-- 500'd for ~26 hours and no result was recorded. Do not drop it again without
-- first confirming `origin='u'` on the target database.
--
-- It also covers `WHERE user_uuid = ?` (leftmost-prefix rule), which is all
-- /api/user does, so no separate Results(user_uuid) index is needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_user_game ON Results(user_uuid, game_id);

-- The admin word-repeat check looks words up directly.
CREATE INDEX IF NOT EXISTS idx_dailywords_word ON DailyWords(word);

-- ===========================================================================
-- Admin authentication (passkeys + server-side sessions).
--
-- Mirrors migrations/0001_admin_auth_and_sessions.sql. That file is what
-- changes a live database; this one only describes the intended end state so a
-- database created from scratch converges with one that got there by
-- migration. Both must be edited together — see migrations/README.md for why
-- neither alone tells you what production looks like.
--
-- The per-column reasoning lives in the migration and is not repeated here.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS AdminUsers (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    -- Stays NOT NULL with passkeys in place, on purpose: a passkey-only admin
    -- holding a dead phone has no second door.
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS AdminCredentials (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    -- UNIQUE globally: excludeCredentials is only a hint, so this is the
    -- constraint that actually prevents a duplicate enrolment.
    credential_id TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,   -- base64url SPKI, straight from getPublicKey()
    algorithm     INTEGER NOT NULL, -- COSE alg: -7 ES256, -257 RS256
    sign_count    INTEGER NOT NULL DEFAULT 0, -- recorded, never enforced
    nickname      TEXT NOT NULL,
    transports    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_used_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_credentials_user ON AdminCredentials(user_id);

CREATE TABLE IF NOT EXISTS AdminChallenges (
    challenge   TEXT PRIMARY KEY,
    -- CHECK-constrained so a registration challenge cannot be redeemed as a
    -- sign-in.
    purpose     TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
    user_id     TEXT,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_challenges_expires ON AdminChallenges(expires_at);

CREATE TABLE IF NOT EXISTS AdminSessions (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    subject_type        TEXT NOT NULL DEFAULT 'admin',
    created_at          TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    expires_at          TEXT NOT NULL,        -- idle deadline, slides forward
    absolute_expires_at TEXT,                 -- ceiling, never moves
    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

-- (Keep a statement last: wrangler warns about a "leftover buffer" if the file
-- ends with comment text after the final semicolon.)
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON AdminSessions(user_id);
