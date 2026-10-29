-- The last part of a player's first IP address seen ("244"), never the
-- whole address. jeff-parker.com's copy of 6Lets sets it when results come
-- in there and shows unnamed players as "Anonymous-244"; 6lets.com doesn't
-- use it yet. Applied to sixlets-db 2026-10-28.
ALTER TABLE Users ADD COLUMN ip_tag TEXT;
