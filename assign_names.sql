UPDATE Users
SET display_name = CASE ABS(RANDOM() % 10)
    WHEN 0 THEN 'Brainiac'
    WHEN 1 THEN 'Whiz Kid'
    WHEN 2 THEN 'Einstein'
    WHEN 3 THEN 'Professor'
    WHEN 4 THEN 'Egghead'
    WHEN 5 THEN 'Sharpie'
    WHEN 6 THEN 'Bright Bulb'
    WHEN 7 THEN 'Kid Genius'
    WHEN 8 THEN 'Know-It-All'
    WHEN 9 THEN 'Walking Encyclopedia'
END
WHERE (display_name IS NULL OR display_name = '')
AND uuid IN (
    SELECT user_uuid FROM Results GROUP BY user_uuid HAVING COUNT(*) > 2
    UNION
    SELECT user_uuid FROM UserState WHERE total_games > 2
);
