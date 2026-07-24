// DEPRECATED / UNUSED.
//
// This endpoint (and the UserState table it used) is no longer referenced by
// the client. Aggregate stats are recomputed server-side in api/user.js from
// the Results table, so this UserState sync path is dead code.
//
// The handlers were removed to avoid exposing an unused, unauthenticated
// read/write endpoint. This file can be deleted from the repository entirely.
