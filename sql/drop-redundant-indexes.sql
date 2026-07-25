-- Drop indexes made redundant by UNIQUE(user_uuid, game_id) on Results.
--
-- That constraint creates an implicit index on (user_uuid, game_id). SQLite's
-- leftmost-prefix rule means it already serves `WHERE user_uuid = ?`, which is
-- the only shape /api/user queries. So both of these are pure write overhead:
--
--   idx_results_user_uuid  - added by the review pass; my error
--   idx_results_user_game  - pre-existing, a straight duplicate of the
--                            constraint's own index
--
-- Dropping an index never touches row data, and both are reversible with a
-- single CREATE INDEX if a query plan ever needs them back.
--
-- Kept: idx_results_game_id (game_id is not a prefix of anything) and
-- idx_dailywords_word (the admin repeat check).

DROP INDEX IF EXISTS idx_results_user_uuid;
DROP INDEX IF EXISTS idx_results_user_game;
