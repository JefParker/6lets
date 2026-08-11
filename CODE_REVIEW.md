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

## Feature — 2026-08-06, passkeys and sliding session expiry

**Not yet deployed or run.** Written without a working sandbox, so nothing below
has been executed — see "Before this ships" at the end.

### Passkeys (WebAuthn), no library

`lib/webauthn.js` does the ceremony on WebCrypto alone. The reason a WebAuthn
server normally needs `@simplewebauthn/server` is the `attestationObject` —
CBOR wrapping authData wrapping a COSE key — and this codebase never sees one.
The browser hands over the same three facts already unwrapped: `getPublicKey()`
returns SPKI that `importKey('spki', …)` takes directly, `getPublicKeyAlgorithm()`
returns the COSE algorithm number, `getAuthenticatorData()` returns raw authData
so the server still checks the rpIdHash and the flags itself.

The objection is "then the client is telling you its own public key". It does
not survive being written out: registration requests `attestation: "none"`, and
a none-format attestation object carries no signature over its contents, so
decoding it authenticates nothing — a lying client could put a different key in
the CBOR and a dutiful parser would learn nothing. Both routes trust the client
identically; one costs 150 lines. And the most a lying client achieves is
registering a credential it controls against an account it is already signed in
to, which it can do through the front door. That reasoning is in the file,
because someone will try to "fix" it.

**Password sign-in stays, and `password_hash` stays NOT NULL.** A passkey lives
on a device; a passkey-only admin with a dead phone has one route back in, and
it is whatever the account-creation script is, at exactly the moment they are
locked out of running it comfortably. On the login modal the password form keeps
first position and the primary button; the passkey is a quiet button underneath,
revealed only where the browser supports it.

Checked on every ceremony: challenge issued by us, unconsumed, unexpired and for
the right ceremony (a registration challenge is not redeemable as a sign-in);
`clientData.type`; `clientData.origin` by **exact** string equality, not
`endsWith`; `crossOrigin !== true`; rpIdHash equals SHA-256 of the RP ID; and
the user-verified flag — `userVerification: "required"` is *requested*, but an
authenticator may ignore the request, so asking without checking means a bare
touch satisfies a login the UI calls a fingerprint.

**The trap with no symptom.** ECDSA signatures arrive DER-wrapped; WebCrypto
wants raw r‖s. Skip the conversion and `crypto.subtle.verify` does not throw —
it returns `false`, for every valid signature, forever, with nothing in any log,
while every other check in the ceremony passes and points at nothing.
`derToRawEcdsaSignature` is the fix and the test suite signs with raw r‖s then
re-wraps it as DER specifically so that deleting the function turns the suite
red.

Other decisions worth not re-litigating:

- **Discoverable credentials** (`residentKey: 'required'`, empty
  `allowCredentials`). The credential knows its own account, so there is no
  username box — and the sign-in options response does not vary with what is
  enrolled, so it enumerates nothing.
- **Challenges are single-use, and that is the whole anti-replay story.**
  Consumed *before* the signature is verified: verify-first-mark-used-on-success
  lets a captured assertion be retried until the challenge expires. The
  consuming `UPDATE … WHERE challenge = ? AND consumed_at IS NULL` is the guard,
  not a preceding `SELECT` — two replays both pass a SELECT, only one changes a
  row.
- **Sign counts are recorded, never enforced.** iCloud Keychain, Google Password
  Manager and every syncing provider return 0 forever by design. Enforcing
  monotonicity locks out the common case and catches nothing.
- **Enrolment requires an existing session**, with `excludeCredentials` passed
  as a hint and the UNIQUE constraint on `credential_id` as the thing that
  actually holds.
- **Every sign-in failure returns one vague message**; the specific reason goes
  to `console.warn`. `NotAllowedError` from the browser means cancelled *or*
  timed out and the browser will not say which, so the client says nothing at
  all — reporting it as a failure is how a working passkey looks broken.
- **RP ID is derived from the request URL, not config.** A passkey made on
  `localhost` will not work on production and vice versa; if the site also
  answers on `*.pages.dev` those are two separate credential namespaces, where
  the button appears on both and finds credentials on one.

### Sessions moved into D1, with two windows

Sessions were a stateless HMAC token. That meant "Log Out" could only clear the
cookie — the token itself stayed valid for its full week in anyone else's hands.
They are now rows in `AdminSessions` and the cookie carries an opaque id, so
logout revokes.

Two windows instead of one lifetime: idle (72h, pushed forward on use) and
absolute (90 days, fixed at creation). A flat 90 days means a stolen cookie is
good for three months whether or not anyone used it.

- **The cookie gets the ABSOLUTE window and is never refreshed.** Give it the
  idle window and the browser drops it after 72 hours while the row is alive and
  sliding — a random sign-out with a perfectly good session in the database.
  That the cookie can name a session which has since gone idle is not a hole:
  the id is opaque and the SQL refuses it. The alternative is `Set-Cookie` on
  every response in the project.
- **Renewal is `MIN(ceiling, MAX(current, wanted))`,** in SQL, reading the
  ceiling from the row inside the UPDATE. `MAX` never shortens (a clock that
  steps back, or a lowered idle window, must not sign out somebody
  mid-sentence); `MIN` is the hard bound and is applied last. Capping in
  application code and then writing `CASE WHEN capped > expires_at` quietly
  ranks never-shorten above the ceiling, because an expiry already past the cap
  cannot be pulled back. The "renewal cannot pass the ceiling" test is what pins
  this down.
- **Renewal is throttled to ~15 minutes,** in the UPDATE's `WHERE` rather than
  an `if` around it, so the dashboard's four-calls-on-load does not become four
  writes.
- **Sliding is opt-in per call site.** `getSession` slides only when passed an
  idle window, and only `requireAdminSession` passes one. A future service
  account keeps flat behaviour until someone decides otherwise, and that
  decision is one argument rather than an accident.
- Timestamps are fixed-width ISO (`YYYY-MM-DDTHH:MM:SSZ`, no milliseconds), so
  the string comparisons in that SQL are chronological.

**Everyone signed in gets signed out once**, since old cookies name no row. That
is the fail-closed direction.

### Admin accounts

There was no admin user table — auth was one `DASHBOARD_USERNAME` /
`DASHBOARD_PASSWORD` pair compared in the worker, and a passkey needs an owner
row. `AdminUsers` is new, seeded automatically from those environment variables
on the first successful login against an empty table, so the migration cannot
lock the dashboard. Once a row exists that bootstrap is inert and rotating the
environment variable changes nothing — use `tools/create-admin.sh` instead.

Login derives a PBKDF2 hash on both paths, against `DECOY_PASSWORD_HASH` when
the username is unknown, so an unknown username is not the fast answer. Note the
decoy is a module constant: building one with `hashPassword()` per request costs
*two* derivations on that path and one on the other, which does not remove the
timing signal so much as double it and point it the other way.

`PBKDF2_ITERATIONS = 100000` is exactly workerd's ceiling — anything higher
throws `NotSupportedError` — so that constant cannot be raised on this runtime.

### Tests

`npm test`, on `node:test` with no new dependencies. The ceremony is exercised
end to end against a synthetic P-256 authenticator built from WebCrypto:
generate a keypair, export SPKI, build authData by hand, sign
`authData ‖ SHA-256(clientDataJSON)`, then convert the signature *up* to DER so
the server has to convert it back down.

Covers: a real signature signs in; the same assertion replayed verbatim is
refused; an unset UV flag is refused; a lookalike origin
(`…example.com.attacker.net`) is refused; a corrupted signature is refused;
session-guarded routes refuse an anonymous caller. Plus the sliding window with
timestamps set directly rather than waited for — new sessions expire on the idle
window not the ceiling, the cookie's Max-Age is the ceiling, use pushes the
expiry forward, a second read seconds later writes nothing, renewal cannot pass
a ceiling set below the current expiry, a shorter idle window does not shorten a
live session, and both ways a session ends.

⚠ **`node:sqlite` is flagged on Node 22.x** (unflagged only in 23.4), and the
database-backed tests skip themselves without it — which would exit 0 having
verified none of the above. `npm test` passes `--experimental-sqlite`, and
`test/database.test.mjs` fails loudly if the module still could not load. That
is deliberate; do not turn it into a skip. It is the same shape as the index
incident above: a green tick describing a command rather than a result.

`tools/commit-and-push.sh` now also runs the suite, and parse-checks `lib/` and
`functions/` with `--input-type=module` — they were never checked at all before,
which is how the `leaderboard.js` change reached production unparsed.

### Before this ships

1. `npm test` — none of it has been run.
2. `npm run db:migrate:preview`, then exercise the dashboard on a preview
   deploy, including enrolling a passkey. Note the RP ID caveat: a passkey
   enrolled on the preview hostname will not work on production.
3. `npm run db:migrate` **then** deploy — in that order, chained with `&&`
   (`npm run deploy:safe`). The new code selects columns that do not exist yet,
   so a deploy that outruns its schema answers 500 on every dashboard route
   while the static pages render perfectly. Schema-ahead-of-code is safe.
4. Verify against the deployed site *after* the build has promoted, not
   immediately after the push — running it straight away tests the previous
   deployment and passes. A Pages build that rejects `wrangler.toml` applies no
   bindings at all and the site looks fine until an API route is called.
5. Sign in with the password, add a passkey, sign out, sign in with the passkey.
6. If any `--remote` command fails with **7403** ("not authorized to access this
   service"), run `wrangler login`. It reads like billing and it is a stale
   OAuth token; `wrangler whoami` will not help, because it prints the scopes
   recorded at last login rather than what the token grants now.

### Found while deploying — preview was never actually isolated

The "Preview and production D1 split" entry above is wrong, and was wrong from
the day it was written. Setting `preview_database_id` inside `[[d1_databases]]`
does **not** bind preview deployments. That key only reaches
`wrangler pages dev` and `wrangler d1 execute --preview`. For Pages, the
top-level `wrangler.toml` configuration *is* the production environment, and a
branch deployment reads `[env.preview]` — with no such section it falls back to
the production binding. So every preview deploy since that change has been
reading and writing live player data.

How it surfaced: a `--branch=passkeys-preview` deployment answered `/api/words`
with a clean 200 while every `/api/dashboard/*` route returned 500. `DailyWords`
exists in both databases, so the working endpoint proved nothing; the failing
ones were reading production, where the `Admin*` tables had not been migrated
yet. The symptom was a missing table and the cause was the wrong database.

Fixed by an explicit `[[env.preview.d1_databases]]` block in `wrangler.toml`.
Environments do not inherit in Wrangler config, so the binding is repeated in
full rather than overriding one key.

This is the same lesson as the index incident, one level up: `preview_database_id`
looked like the isolation and never was, exactly as `CREATE TABLE IF NOT EXISTS`
looked like the constraint and never was. Both were verified by reading the
config file rather than asking the running system.

### Found while deploying — `wrangler d1 execute --file` is refused

`--file` uploads through D1's bulk-import endpoint, which returns
`Authentication error [code: 10000]` on this account — before and after a fresh
`wrangler login`. The ordinary query endpoint accepted `--command` on the same
token seconds later, both reads and DDL writes, so it is that one API surface
being refused rather than the token, the account or the permissions.

`wrangler whoami` printed `d1 (write)` and "Super Administrator - All
Privileges" throughout. It reports the scopes recorded in the local config file
at last login, not what the token currently grants, so it cannot answer this
question and confidently appears to.

`tools/migrate.sh` works around it by sending the whole migration file as one
`--command` through the endpoint that works; `npm run db:migrate` now goes
through it. Wrangler splits the command into statements with a real SQL parser,
so `--` and `;` inside string literals survive — an earlier version of the
script split on `;` with sed/tr, which would have cut such a statement in half.

**Still open:** there is no rate limiting on `/api/dashboard/*`.
`passkeys/signin-options` is unauthenticated and writes an `AdminChallenges` row
per call, and `login` burns a PBKDF2 derivation per call. Neither is a new hole
— `login` was always unauthenticated — but both are cheaper to hammer than they
were. A Cloudflare WAF rate-limiting rule on that path prefix is the fix, and it
lives in the dashboard rather than in this repo.

## Still open (cosmetic, your call)

1. **Missing art.** I removed the manifest entries for `6lets-maskable-512.png` and `6Lets-Desktop-SS.png` rather than inventing them. Add the files if you want a maskable icon and a wide install-prompt screenshot. `apple-touch-icon` currently points at `6lets192.png`; a dedicated 180×180 would be better.
2. **`SummeryCard.png`** keeps its typo — `og:image` points at the current name, so renaming means updating `index.html` too.
3. **Local dev on a shared port.** Another project's service worker owns `localhost:8788`. Since 6Lets' one-time `6lets_wiped_v1` migration calls `localStorage.clear()`, which wipes the whole origin, keep 6Lets on its own port (8791) to avoid eating the other app's data.
