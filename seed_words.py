#!/usr/bin/env python3
"""
6Lets -- RETRACTED 2026-07-26. This script no longer does anything.

Superseded by tools/regenerate-words.py.

WHAT IT USED TO DO
------------------
It generated seed.sql: 60 days of puzzles from 2026-07-08, drawing from a
hardcoded ~200-word `common_words` list, with a `themes` dict pinning specific
answers to specific dates (National Sugar Cookie Day, Bastille Day, and so on).

WHY IT WAS RETIRED
------------------
This repository is public. The script therefore published, in plaintext:

  * the exact answer for thirteen dated puzzles, straight out of `themes`
    (2026-08-08 -> FELINE/KITTEN, 2026-09-05 -> DONATE/GIVING, ...)
  * the complete candidate pool every other day was drawn from, which narrowed
    any remaining puzzle to a couple of hundred guesses

And its output, seed.sql, was committed too -- so all 120 answers through
2026-09-05 were readable directly. That defeated the point of /api/words, which
base64-obfuscates words and serves only a four-entry look-ahead precisely so
nobody can read forward.

Deleting these files would not have fixed it: the blobs stay in git history and
a public repo has no recall. Every affected puzzle was regenerated on
2026-07-26 and the schedule now lives only on Jake's machine and in D1.

THE RULE NOW
------------
The answer key is never committed. seed.sql, seed.local.sql, and *.local.sql
are gitignored. Bulk scheduling goes through:

    python3 tools/regenerate-words.py --start YYYY-MM-DD --days 120

Day-to-day edits go through the admin dashboard.

Note the distinction this file got wrong, and which regenerate-words.py keeps:
public/dictionary.js is the list of guesses the game ACCEPTS (~30,000 words,
necessarily broad, safe to publish). Answers must come from a much narrower
pool of common words -- and must also appear in dictionary.js, or the client
would reject the answer as an invalid guess and the puzzle would be unsolvable.
"""

import sys

sys.exit(
    "seed_words.py is retracted and does nothing.\n"
    "\n"
    "  It published the puzzle answer key to a public repository.\n"
    "  See the docstring in this file.\n"
    "\n"
    "  Use instead:\n"
    "    python3 tools/regenerate-words.py --start YYYY-MM-DD --days 120\n"
)
