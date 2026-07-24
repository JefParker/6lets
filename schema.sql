-- schema.sql

DROP TABLE IF EXISTS Users;
CREATE TABLE Users (
    uuid TEXT PRIMARY KEY,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS DailyWords;
CREATE TABLE DailyWords (
    id TEXT PRIMARY KEY, -- e.g., '2026-07-08-AM'
    word TEXT NOT NULL
);

DROP TABLE IF EXISTS Results;
CREATE TABLE Results (
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
