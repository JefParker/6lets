-- Curated answer candidates for the automatic schedule top-up.
--
-- The pool is seeded from regenerate-words.py's COMMON_WORDS (minus burned
-- words) via its --emit-pool mode; lib/runway.js draws from it whenever the
-- scheduled runway drops below the 40-day floor. A word's availability is NOT
-- tracked here: a candidate is available exactly while it appears nowhere in
-- DailyWords, so scheduling a word (by top-up, by regenerate-words.py, or by
-- hand in the dashboard) retires it from the pool automatically and there is
-- no second copy of that state to drift.
--
-- Committing pool *membership* is fine — COMMON_WORDS is already public in
-- this repo. The secret is only ever which word landed on which day.
--
-- Safe to re-run: IF NOT EXISTS, no writes to existing tables.

CREATE TABLE IF NOT EXISTS AnswerPool (
    word TEXT PRIMARY KEY CHECK (length(word) = 6)
);
