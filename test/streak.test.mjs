// The streak /api/user reports is a plain count: puzzles finished in a row,
// won or lost, up to the newest one finished. A puzzle that went by unplayed
// breaks it, and one that has gone by since the newest result zeroes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playedStreak } from '../lib/puzzle.js';

test('counts finished puzzles in a row, newest first, in any order', () => {
    assert.deepEqual(playedStreak([3300, 3298, 3299]), { streak: 3, lastPlayed: 3300 });
});

test('a gap ends the run', () => {
    assert.deepEqual(playedStreak([3300, 3299, 3297, 3296]), { streak: 2, lastPlayed: 3300 });
});

test('the current puzzle, or the one before it, keeps the run live', () => {
    assert.equal(playedStreak([3300, 3299], 3300).streak, 2);
    assert.equal(playedStreak([3300, 3299], 3301).streak, 2);
});

test('a puzzle that went by unplayed zeroes it', () => {
    assert.deepEqual(playedStreak([3300, 3299], 3302), { streak: 0, lastPlayed: 3300 });
});

test('no results, duplicates and bad numbers', () => {
    assert.deepEqual(playedStreak([]), { streak: 0, lastPlayed: 0 });
    assert.equal(playedStreak([3300, 3300, 3299, null, NaN]).streak, 2);
});
