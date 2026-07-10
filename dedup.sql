-- Remove duplicates by keeping the one with the maximum played_at or most recent id for each user/game combination.
DELETE FROM Results
WHERE id NOT IN (
    SELECT id
    FROM (
        SELECT id, ROW_NUMBER() OVER(PARTITION BY user_uuid, game_id ORDER BY played_at DESC) as rn
        FROM Results
    )
    WHERE rn = 1
);

-- SQLite does not support adding constraints directly to an existing table. 
-- However, we can create a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_user_game ON Results(user_uuid, game_id);
