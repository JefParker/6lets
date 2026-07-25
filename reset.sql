-- reset.sql
--
-- DESTRUCTIVE. Drops every table and all player history. Intended for local /
-- preview databases only. Run schema.sql afterwards to recreate the tables.
--
--   wrangler d1 execute sixlets-db --local --file=reset.sql
--   wrangler d1 execute sixlets-db --local --file=schema.sql

DROP TABLE IF EXISTS Results;
DROP TABLE IF EXISTS DailyWords;
DROP TABLE IF EXISTS Users;
