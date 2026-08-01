#!/usr/bin/env python3
"""
6Lets -- rebuild public/dictionary.js, the list of ACCEPTED GUESSES.

This is not the answer key, and it is safe to publish. Two different word lists
do two different jobs:

  public/dictionary.js  (this script)  ~30,000 six-letter words. Decides which
                                       guesses the game accepts. Has to be
                                       broad: telling a player that a real word
                                       is not a word is the worst failure mode.
                                       Ships to every browser, so it is public
                                       by definition.

  the daily answers     (tools/regenerate-words.py)  a narrow pool of common,
                                       guessable words. Secret. Never committed
                                       -- see the docstring in seed_words.py
                                       for what happened when it was.

CAUTION
-------
Rerunning this replaces dictionary.js wholesale. If the upstream list has
changed, a word already scheduled as a future answer could disappear from it --
and an answer the client rejects as an invalid guess is unsolvable: the player
cannot type it even knowing it.

So after rerunning, re-check the schedule against the new dictionary:

    npx wrangler d1 execute sixlets-db --remote \
      --command "SELECT id, word FROM DailyWords WHERE id >= '$(date +%Y-%m-%d)';"

and confirm every word still appears in public/dictionary.js. Bump the asset
version in index.html and CACHE_NAME in sw.js too, or returning players keep
the cached copy.
"""

import json
import urllib.error
import urllib.request

URL = "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"
OUT = 'public/dictionary.js'

print("Downloading words...")
try:
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read().decode('utf-8').splitlines()
except (urllib.error.URLError, OSError) as e:
    raise SystemExit(f"download failed ({e}). {OUT} left untouched.")

six_letter_words = [word.strip().lower() for word in data if len(word.strip()) == 6]

print(f"Found {len(six_letter_words)} 6-letter words.")

# A truncated or failed download would otherwise silently gut the dictionary
# and start rejecting ordinary guesses.
if len(six_letter_words) < 10000:
    raise SystemExit(
        f"only {len(six_letter_words)} words parsed -- that is far below the "
        f"expected ~30,000. Refusing to overwrite {OUT}."
    )

with open(OUT, 'w') as f:
    f.write(f"const VALID_WORDS = new Set({json.dumps(six_letter_words)});\n")

print(f"Wrote {OUT}.")
print("Now re-check that every scheduled answer still appears in it "
      "(see the caution in this file's docstring).")
