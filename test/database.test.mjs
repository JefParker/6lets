import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteAvailable, sqliteImportError } from './helpers/d1.mjs';

// The tripwire for a silently green suite.
//
// Everything that actually exercises the sliding window, the ceiling clamp, the
// renewal throttle and the challenge-replay refusal needs a real SQLite engine,
// and those tests skip themselves when node:sqlite is missing. Skipped tests
// still exit 0. So without this one case, running the suite on a Node that
// cannot load node:sqlite prints a green tick for having verified nothing —
// which is the same shape as the 26-hour outage in CODE_REVIEW.md, where
// "applied to production" described a command rather than a result.
//
// This test fails instead. It is meant to be annoying.
test('the database-backed tests can actually run', () => {
    assert.ok(
        sqliteAvailable,
        'node:sqlite could not be loaded, so every database-backed test in this suite ' +
        'skipped and verified nothing. Run `npm test` (which passes --experimental-sqlite), ' +
        'or use Node 23.4+ where the module is unflagged. Underlying error: ' +
        String(sqliteImportError())
    );
});
