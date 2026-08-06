-- 0001_admin_auth_and_sessions.sql
--
-- Adds passkey (WebAuthn) sign-in and server-side sessions for the admin
-- dashboard. Safe to re-run: every statement is IF NOT EXISTS or idempotent.
--
-- Touches no existing table. `Users`, `DailyWords` and `Results` are player
-- data and are deliberately not reused here — `Users.uuid` is a browser-
-- generated player id with no credential attached to it, and joining admin
-- accounts to it would make every player row a potential admin row.
--
-- ONE-TIME EFFECT ON SIGNED-IN ADMINS: sessions used to be a stateless
-- HMAC token that named no server-side row. After this migration and the
-- matching deploy, those cookies refer to a session that does not exist and
-- are refused, so anyone signed in is signed out once. That is the fail-closed
-- direction, and it is also the point of the change: a stateless token cannot
-- be revoked, so the old "Log Out" cleared the cookie while the token itself
-- stayed valid for its full week in anyone else's hands.

-- Timestamps throughout are TEXT in a fixed-width ISO shape:
--   YYYY-MM-DDTHH:MM:SSZ   (UTC, no milliseconds)
-- Fixed width is load-bearing, not cosmetic. Session renewal compares and
-- takes MIN/MAX of these values as *strings* in SQL. String order is only
-- chronological if every value is the same length, so a stray millisecond
-- component ('...T00:00:00.5Z' sorts after '...T00:00:01Z') would silently
-- corrupt the comparison rather than fail. Write them with isoSeconds() in
-- lib/auth.js, never with an ad-hoc toISOString().

CREATE TABLE IF NOT EXISTS AdminUsers (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    -- NOT NULL, and it stays NOT NULL even once passkeys work.
    --
    -- A passkey lives on a device. An admin with a passkey and no password,
    -- holding a dead phone, has exactly one route back in: whatever the
    -- account-creation script is, at the precise moment they are locked out
    -- of the thing that would let them run it comfortably. Two doors that are
    -- both audited cost less than one door plus a recovery procedure nobody
    -- has rehearsed.
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS AdminCredentials (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,

    -- UNIQUE across all users, not per user. `excludeCredentials` asks an
    -- authenticator not to enrol the same device twice, but it is a hint the
    -- authenticator is free to ignore, so this constraint is what actually
    -- holds. Global rather than per-user because a credential id is what a
    -- sign-in assertion is looked up by, and that lookup happens before any
    -- user is known — two users sharing one would make the lookup ambiguous.
    credential_id TEXT NOT NULL UNIQUE,

    -- base64url SPKI, exactly as the browser's getPublicKey() returned it, so
    -- it goes straight into crypto.subtle.importKey('spki', ...) with no
    -- intermediate decoding. See the long comment in lib/webauthn.js for why
    -- there is no COSE/CBOR parsing anywhere in this codebase.
    public_key    TEXT NOT NULL,

    -- COSE algorithm number: -7 (ES256) or -257 (RS256). Stored because the
    -- verify step needs to know which one to import the key as, and rejected
    -- at registration if it is neither.
    algorithm     INTEGER NOT NULL,

    -- Recorded, never enforced. See getSession/verifyAssertion notes: syncing
    -- providers (iCloud Keychain, Google Password Manager) return 0 forever by
    -- design, because the credential is *supposed* to exist on every device.
    -- Enforcing monotonicity locks out the common case and detects nothing.
    sign_count    INTEGER NOT NULL DEFAULT 0,

    -- Required, and it matters more than it looks. Without a label the
    -- management screen is three identical rows and nobody dares delete any of
    -- them, which is how stale credentials accumulate forever.
    nickname      TEXT NOT NULL,

    transports    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_used_at  TEXT,

    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_credentials_user
    ON AdminCredentials(user_id);

CREATE TABLE IF NOT EXISTS AdminChallenges (
    challenge  TEXT PRIMARY KEY,

    -- CHECK-constrained because the two ceremonies must not share a pool. A
    -- registration challenge that could be redeemed as a sign-in would let
    -- anyone who can trigger an enrolment obtain a challenge that signs them
    -- in; the purpose column is what makes "issued for this ceremony" a thing
    -- the database can refuse rather than a thing the caller remembers to check.
    purpose    TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),

    -- NULL for authentication: discoverable credentials mean the browser's own
    -- picker decides which account is signing in, so at the point the challenge
    -- is issued the server does not yet know — and must not ask, because asking
    -- is a username box that enumerates accounts.
    user_id    TEXT,

    expires_at TEXT NOT NULL,
    consumed_at TEXT,

    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

-- Supports the sweep of expired rows; challenges are short-lived and there is
-- no reason to keep them once spent.
CREATE INDEX IF NOT EXISTS idx_admin_challenges_expires
    ON AdminChallenges(expires_at);

CREATE TABLE IF NOT EXISTS AdminSessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,

    -- Which kind of principal this session belongs to. Only 'admin' exists
    -- today. It is here so that sliding expiry can stay opt-in per call site:
    -- a future service-account session keeps flat behaviour until somebody
    -- deliberately passes an idle window for it, rather than inheriting one by
    -- accident because it happened to go through the same helper.
    subject_type  TEXT NOT NULL DEFAULT 'admin',

    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,

    -- The idle deadline. Moves forward as the session is used.
    expires_at    TEXT NOT NULL,

    -- The ceiling. Fixed at creation and never moved, so no session is
    -- immortal however much it is used.
    absolute_expires_at TEXT,

    FOREIGN KEY (user_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
    ON AdminSessions(user_id);

-- Conservative backfill.
--
-- A no-op on a fresh database, where the table above was just created empty.
-- It is here for the re-run and for any database that somehow carries session
-- rows predating the ceiling: those get a ceiling equal to the expiry they
-- already had, so a session issued before this migration cannot be *extended*
-- by it.
--
-- Backfilling `now + 90 days` instead would silently hand a longer life to
-- every session open at the moment the migration runs — including whichever
-- one is open because somebody walked away from an unlocked machine.
UPDATE AdminSessions
   SET absolute_expires_at = expires_at
 WHERE absolute_expires_at IS NULL;
