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

DROP TABLE IF EXISTS UserState;
CREATE TABLE UserState (
    user_uuid TEXT PRIMARY KEY,
    stats TEXT,
    history TEXT,
    total_games INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_uuid) REFERENCES Users(uuid)
);
