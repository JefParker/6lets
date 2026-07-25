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

-- No index on Results(user_uuid) is needed. UNIQUE(user_uuid, game_id) above
-- already creates an implicit index on that pair, and SQLite uses it for
-- `WHERE user_uuid = ?` (leftmost-prefix rule) — which is all /api/user does.
-- A standalone user_uuid index, or a duplicate (user_uuid, game_id) index,
-- costs a write on every result insert and buys nothing. See
-- tools/drop-redundant-indexes.sh.

-- The admin word-repeat check looks words up directly.
-- (Keep this last: wrangler warns about a "leftover buffer" if the file ends
-- with comment text after the final semicolon.)
CREATE INDEX IF NOT EXISTS idx_dailywords_word ON DailyWords(word);
