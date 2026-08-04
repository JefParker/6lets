# 6Lets — Code Review Fixes

All findings from the review have been applied. This file is the record of what changed and what still needs you.

---

## New files

| File | Purpose |
|---|---|
| `lib/puzzle.js` | Shared server-side puzzle identity — `getCurrentGameId()`, `getPuzzleNumber()`, `GAME_ID_PATTERN`. Replaces four drifting copies. |
| `lib/auth.js` | Shared dashboard auth — token signing/verification, cookie construction, `timingSafeEqual`. |
| `functions/api/dashboard/logout.js` | Server-side session teardown (the cookie is `HttpOnly`, so the client can't clear it). |
| `public/_headers` | CSP, `X-Frame-Options`, `nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy`. |
| `reset.sql` | The destructive `DROP TABLE` statements, moved out of `schema.sql`. |

---

## Critical

**1. Stored XSS in the admin leaderboard.** `loadAdminLeaderboard` now builds rows with `createElement` + `textContent` instead of interpolating `display_name` into `innerHTML`. Second layer: `POST /api/user` rejects names over 24 characters or containing control characters, `<`, or `>`, and both name inputs carry `maxlength="24"`.

**2. Transient DB error wiping the offline word cache.** `/api/words` now returns `500` instead of `200` + `[]`, and the client refuses to overwrite a good cache with an empty list. `determineTargetWord` also catches malformed base64 (which used to throw out of the init chain and leave the board unrendered) and length-checks the decoded word.

**3. "Log Out" not logging out.** Added `POST /api/dashboard/logout`, which returns a `Max-Age=0` cookie; the button now calls it.

**4. `/api/results` unvalidated.** Range checks per the option you picked: UUID format, `game_id` format, `guesses_taken` an integer in 1–10, `time_taken_ms` finite and within 24h, `guesses` blob length-capped, batch capped at 100 records.

**5. Foreign-key failure poisoning the sync queue.** The endpoint now looks up which `game_id`s exist in `DailyWords` and silently drops the rest, so one bad record can't abort the atomic batch. A 2xx therefore means "everything processable was processed" and the client clears its queue; only 5xx retries, and a 4xx discards. The queue is also deduplicated on `(user_uuid, game_id)` and capped at 50.

---

## High

**6. Midnight rollover.** `hour12: false` → `hourCycle: 'h23'`, plus an `if (hour === 24) hour = 0` fallback, in both the client and `lib/puzzle.js`.

**7. Dead streak-break logic.** `autoRecoverStreak` takes an `anchorPuzzle` argument and refuses to recover a run whose most recent entry is older than `anchorPuzzle - 1`. It can no longer resurrect the streak that `loadState` just zeroed.

**8. Stale `startTime` inflating leaderboard times.** A persisted `startTime` is never resumed. Only the verifiable segment (start marker → last save) is banked, then the clock restarts on the next keystroke. Added a `pagehide` listener alongside `visibilitychange` for the cases the latter misses.

**9. Player ID switch not clearing game state.** The three non-existent keys are replaced with `clearAllGameStateKeys()`, which removes every real `gameState_*` key, plus `6lets_lastGameId` and the cached display name.

**10. Typing during the flip animation.** An `isRevealing` flag locks input for the duration of the reveal, and the submitted row drops its `active-row` id immediately so a stray `updateActiveRow()` can't blank it.

---

## Medium

**11.** `words.js` repeat-check excludes the row being edited in SQL (`AND id != ?`) rather than comparing one arbitrary `.first()` result afterwards, so a genuine collision on another date can't slip through.

**12.** Admin words are validated against `VALID_WORDS` client-side and `/^[A-Z]{6}$/` server-side. Validation is scoped to the halves that actually changed, so an already-stored non-dictionary word can't block editing the other half of that date.

**13.** Cookie gains `Secure`. `SECRET_KEY` now throws if unset instead of HMAC-ing with the literal bytes `"undefined"`. `verifyAuth` checks the token's `user` claim against `DASHBOARD_USERNAME` and validates token structure before decoding.

**14.** One `getPuzzleNumber` per runtime. It returns `null` for malformed input rather than a misleading fallback number; all nine call sites handle `null`.

**15.** The `amWord !== undefined` dead branch is gone — only changed halves are POSTed, so editing PM no longer deletes AM.

**16.** `recentGames` is capped at 10 on the win path too, matching the loss path and the server.

**17.** Service worker is network-first for navigations (cache as fallback), the `controllerchange` reload is re-enabled behind the existing `refreshing` latch and skipped mid-game, and `CACHE_NAME` is bumped to `v41`. Added `.catch()` to the runtime `cache.put` calls.

**18.** Removed the three references to non-existent images; `apple-touch-icon` points at `6lets192.png`. `theme_color` aligned to `#1e1e1e` in both places.

**19.** Added `og:` and `twitter:` tags pointing at the existing `img/SummeryCard.png`.

---

## Low / cleanup

- `pruneOldStorageKeys()` runs on load, keeping only the current and previous puzzle's `gameState_*` and `6lets_globalStats_*` keys.
- `saveState()` writes one key per keystroke; the five aggregates moved to `persistAggregateStats()`, called when a game finishes.
- `schema.sql` is now `CREATE TABLE IF NOT EXISTS` only, plus three new indexes (`Results.game_id`, `Results.user_uuid`, `DailyWords.word`). Drops live in `reset.sql`.
- `package.json`: real `dev`/`deploy`/`db:schema`/`db:reset` scripts, `private: true`, removed the bogus `main`.
- `user-scalable=no` removed from the viewport meta (WCAG 1.4.4).
- Stats modal close button targeted by id rather than `querySelector('.close-btn')`.
- `checkForNewGame` closes only the four game-flow modals, not settings or the admin dashboard.
- `buildGraph` pads its input to 11 buckets, so a 10-element distribution can't yield `NaN` bar heights.
- Wake lock retries on every `visible` transition, not only when one was already held.
- `getUserUUID` no longer writes on every call; `crypto` guarded with `typeof`.
- Every `JSON.parse` of stored/remote data is wrapped — corrupt localStorage no longer takes the app down.
- API error responses no longer echo `e.message` to the client.
- Both display-name save paths surface the server's validation message.

Found and fixed during verification (not in the original review): a guess is recorded before the ~1s reveal resolves it, so a page unload inside that window left a decided board stuck in `playing` — on the 10th guess with no row to type into and a `TypeError` on the next Enter. `resolveInterruptedGame()` settles it on load, guarded so it never runs against the offline fallback word.

---

## Done since

- Secrets `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` / `SECRET_KEY` pushed to Pages; `.dev.vars` written for local dev.
- `schema.sql` applied to production. `puppeteer` removed and the lockfile regenerated. `wrangler` upgraded to 4.114.0, clearing three high-severity advisories in its `sharp` dependency.
- **Preview and production D1 split.** `sixlets-db-preview` (`5da8b71d…`) created, seeded from `seed.sql`, and wired to `preview_database_id`. Preview deploys no longer read or write live player data.
- ~~**Redundant indexes dropped** on both databases.~~ **Reverted 2026-07-26 — this was wrong and took the leaderboard down.** See "Incident" below. `idx_results_user_game` is required and is now declared in `schema.sql`.
- `console.error` added to every API catch block, so the real exception reaches the server log while the client still gets a generic message.
- **Verified locally.** Every route returned 200: `/api/words`, `/api/user` GET+POST, `/api/results`, `/api/game_stats`, `/api/dashboard/{login,logout,words,leaderboard}`. A single-half admin save fired exactly one POST, confirming the changed-halves-only fix.

## Incident — 2026-07-25/26, no results recorded for ~26 hours

**Symptom.** Players completed games and shared scores, but both leaderboards
(post-game "Top Players" and the admin AM/PM cards) showed nothing, and
`/api/game_stats` reported zero players.

**Cause.** `tools/drop-redundant-indexes.sh` dropped `idx_results_user_game`
from production, on the stated grounds that `UNIQUE(user_uuid, game_id)` in
`schema.sql` made it a duplicate. Production never had that constraint:
`schema.sql` creates `Results` with `CREATE TABLE IF NOT EXISTS`, which is a
no-op against the pre-existing production table, so the constraint only ever
reached databases this file created. `PRAGMA index_list('Results')` returned no
row with `origin='u'` — confirming the table had no such constraint.

That index was the only uniqueness on `(user_uuid, game_id)`, and therefore the
only valid conflict target for the `ON CONFLICT(user_uuid, game_id) DO UPDATE`
upsert in `functions/api/results.js`. Once dropped, every insert threw
`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`, was
caught, and returned 500.

**Why it was silent.** `syncResults()` treats 5xx as retry-later: it keeps the
queue and shows the player nothing. So results accumulated in each browser's
`pending_sync` while the server recorded none. Nothing was lost — the queue is
deduplicated on `(user_uuid, game_id)` and capped at 50 entries (~25 days), and
`syncResults()` runs on load and on `online`, so backlogs flushed as players
reopened the game.

**Timeline.** Last good write `2026-07-25 21:50:57Z` (14:50 PT), roughly 16
minutes after `wrangler.toml.bak.20260725143412`. Diagnosed and fixed
`2026-07-26` by recreating the index; first new write `2026-07-26 16:17:41Z`.

**Fixes applied.**

- `CREATE UNIQUE INDEX IF NOT EXISTS idx_results_user_game ON Results(user_uuid, game_id)`
  run against production, and now declared in `schema.sql` so fresh databases
  and production converge. It succeeded cleanly, confirming no duplicate rows
  were written during the window.
- `tools/drop-redundant-indexes.sh` and `sql/drop-redundant-indexes.sql`
  retracted — both are now no-ops that explain why and exit non-zero.

**Lesson.** `CREATE TABLE IF NOT EXISTS` can never alter an existing table, so
"schema.sql applied to production" says nothing about production's constraints.
Verify against the live database (`PRAGMA index_list`, `sqlite_master`) before
reasoning from the schema file — the two had silently diverged for months. A
migrations directory, or a verify step that diffs live `sqlite_master` against
the intended schema, would have caught this.

**Detection, added 2026-07-26.** `syncResults()` now counts consecutive
failures. After `SYNC_FAILURE_WARN_THRESHOLD` (3) the stats modal shows a banner
above the leaderboard explaining that scores haven't reached the server and are
safe on the device — placed where the player is already noticing they're
missing. A 4xx is different: the queue is discarded, so those results are gone
rather than delayed, and that warns on the first occurrence. A successful sync,
or an empty queue on the next load, clears the state. Assets bumped to `v42`.

This is a detection mechanism, not a fix. It converts "the leaderboard is
broken" into a report that says which half of the system failed — which is the
part that cost the 26 hours.

## Incident — 2026-07-26, the public repo published the answer key

`github.com/JefParker/6lets` is a public repository, and two committed files
gave away the puzzle schedule:

- **`seed.sql`** — 120 dated answers in plaintext, `2026-07-08-AM` through
  `2026-09-05-PM`.
- **`seed_words.py`** — the generator. Its `themes` dict names the exact answer
  for thirteen dates (`2026-08-08 → FELINE/KITTEN`, `2026-09-05 →
  DONATE/GIVING`, and so on), and its `common_words` list is the entire ~200-word
  pool the generic days draw from.

This defeated `/api/words` entirely. That endpoint base64-obfuscates words and
serves only a four-entry look-ahead specifically so nobody can read forward —
all of which is moot when the whole schedule is a `git clone` away.

**Deleting the files does not fix it.** The blobs stay readable in history, and
a public repo has no recall. The words themselves had to change.

**Fixed.**

- `tools/regenerate-words.py` draws replacements from `public/dictionary.js`
  (guaranteeing every answer is typeable — a word outside that list would be
  unsolvable), excludes everything already published in `seed.sql` and
  `seed_words.py`, and picks with `secrets.SystemRandom` so the schedule cannot
  be reproduced from a seed even by someone holding the script. It emits
  upserts for future dates only, never a `DELETE`.
- `.gitignore` now covers `seed.sql`, `seed.local.sql`, and `*.local.sql`.
- All puzzles from 2026-07-27 onward regenerated and applied to production.

**Never run the old `seed.sql` against production.** It opens with
`DELETE FROM DailyWords;`, and `Results` carries a foreign key to
`DailyWords(id)` — it would orphan or destroy real player history. It is safe
only against a database whose name contains "preview", which is the guard
`tools/split-preview-db.sh` enforces.

**The repo is staying public**, so the standing rule is: the word list lives on
Jake's machine and in D1, never in git. Day-to-day scheduling goes through the
admin dashboard; bulk scheduling goes through `regenerate-words.py`.

**Also exposed:** `tools/setup-and-verify.sh` hardcoded `DASHBOARD_PASSWORD`
for several commits before 2026-07-26. It now reads credentials from the
environment, but the old value is in history and on a public repo — it must be
rotated, not merely removed.

## Feature — 2026-08-04, guess grids on the stats leaderboard

Clicking a row in the post-game "Top Players" list opens a popup showing that
player's display name, their guesses/time line, and their emoji guess grid.

**The grid is scored on the server, deliberately.** `/api/dashboard/leaderboard`
now joins `DailyWords` and derives each player's emoji pattern in the worker,
returning `pattern: ['⬛🟩…', …]` instead of the stored `guesses` blob. Returning
the raw guesses would have been the obvious implementation and would have
published the answer: the endpoint has no auth check, every leaderboard row is a
solved game, and a solved game's last guess *is* the target word. Anyone could
have read the current answer — and, with the endpoint accepting an arbitrary
`game_id`, any past one — straight out of a JSON response. The emoji pattern
carries positions but no letters, so it is safe to serve. Neither `r.guesses`
nor `d.word` appears in the payload.

This is the same class of leak as the `seed.sql` incident above: the answer
escaping through a channel nobody thought of as an answer channel. The rule that
`/api/words` follows — never serve a word the player hasn't earned — has to hold
for every endpoint, not just the one named after words.

`toEmojiRow()` duplicates the scoring logic in `getShareText()` (`public/script.js`)
rather than sharing it, because the client copy is inline in a function that also
formats dates and builds share text. The two must stay in sync; duplicate-letter
handling in particular (claim exact matches first, then let each remaining target
letter satisfy at most one present marker) is easy to get subtly wrong.

**Appearance is unchanged by request.** `.leaderboard-row.is-clickable` sets
`cursor` and nothing else — no colour, no underline. Because there is no visual
affordance, the rows are given `tabIndex = 0`, `role="button"` and an Enter/Space
handler, or they would be unreachable without a mouse.

`#player-grid-popup` is a sibling of the modals at `z-index: 200`, above
`.modal`'s 101, so the stats modal stays visible behind it and closing the popup
returns the player to the leaderboard. It lives outside `#stats-modal`, so every
path that hides the modal — the close button, `showStatsModal()`, and
`checkForNewGame()` — also calls `hidePlayerGrid()`; otherwise it would be left
floating over the board.

Results saved before `guesses` was stored have a null pattern and show
"No grid saved for this game." Malformed blobs take the same path rather than
throwing. Assets and `CACHE_NAME` bumped to `v44`.

The admin dashboard leaderboard was left alone. It ignores the new field.

**Untested by the tooling.** `commit-and-push.sh` runs `node --check` on
`public/*.js` only, so the change to `functions/api/dashboard/leaderboard.js`
was not parse-checked before pushing.

## Still open (cosmetic, your call)

1. **Missing art.** I removed the manifest entries for `6lets-maskable-512.png` and `6Lets-Desktop-SS.png` rather than inventing them. Add the files if you want a maskable icon and a wide install-prompt screenshot. `apple-touch-icon` currently points at `6lets192.png`; a dedicated 180×180 would be better.
2. **`SummeryCard.png`** keeps its typo — `og:image` points at the current name, so renaming means updating `index.html` too.
3. **Local dev on a shared port.** Another project's service worker owns `localhost:8788`. Since 6Lets' one-time `6lets_wiped_v1` migration calls `localStorage.clear()`, which wipes the whole origin, keep 6Lets on its own port (8791) to avoid eating the other app's data.
