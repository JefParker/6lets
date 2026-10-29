-- Leaderboard tag for unnamed players: "Anonymous" plus the last part of
-- their first IP address seen ("Anonymous-244"), never the whole address.
-- Both 6lets.com and jeff-parker.com's copy of 6Lets set it when results come
-- in and show it on the leaderboard (lib/anon.js here, lib/validate.js there).
--
-- A table of its own rather than a column on Users, so this file stays safe
-- to re-run like every migration here (SQLite has no ADD COLUMN IF NOT
-- EXISTS). Applied to sixlets-db and sixlets-db-preview 2026-10-28.

CREATE TABLE IF NOT EXISTS PlayerTags (
    uuid TEXT PRIMARY KEY,
    ip_tag TEXT NOT NULL
);
