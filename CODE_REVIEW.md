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
- **Redundant indexes dropped** on both databases. `UNIQUE(user_uuid, game_id)` already covers `WHERE user_uuid = ?` by leftmost prefix, so `idx_results_user_uuid` (added by this review — my error) and `idx_results_user_game` (pre-existing) were pure write overhead. `idx_results_game_id` and `idx_dailywords_word` remain.
- `console.error` added to every API catch block, so the real exception reaches the server log while the client still gets a generic message.
- **Verified locally.** Every route returned 200: `/api/words`, `/api/user` GET+POST, `/api/results`, `/api/game_stats`, `/api/dashboard/{login,logout,words,leaderboard}`. A single-half admin save fired exactly one POST, confirming the changed-halves-only fix.

## Still open (cosmetic, your call)

1. **Missing art.** I removed the manifest entries for `6lets-maskable-512.png` and `6Lets-Desktop-SS.png` rather than inventing them. Add the files if you want a maskable icon and a wide install-prompt screenshot. `apple-touch-icon` currently points at `6lets192.png`; a dedicated 180×180 would be better.
2. **`SummeryCard.png`** keeps its typo — `og:image` points at the current name, so renaming means updating `index.html` too.
3. **Local dev on a shared port.** Another project's service worker owns `localhost:8788`. Since 6Lets' one-time `6lets_wiped_v1` migration calls `localStorage.clear()`, which wipes the whole origin, keep 6Lets on its own port (8791) to avoid eating the other app's data.
