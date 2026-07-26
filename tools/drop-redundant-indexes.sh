#!/usr/bin/env bash
#
# 6Lets — RETRACTED 2026-07-26. This script no longer does anything.
#
# It used to drop idx_results_user_uuid and idx_results_user_game from the
# production, preview, and local databases, on the theory that
# UNIQUE(user_uuid, game_id) in schema.sql already covered that pair.
#
# It did not, on production. schema.sql builds Results with CREATE TABLE IF NOT
# EXISTS, which is a no-op against an existing table, so the UNIQUE constraint
# never reached the live database. idx_results_user_game was the only uniqueness
# on (user_uuid, game_id) — and thus the only valid conflict target for the
# ON CONFLICT(user_uuid, game_id) upsert in functions/api/results.js.
#
# Running this on 2026-07-25 made every POST /api/results throw and return 500.
# The client retries 500s silently, so nothing surfaced: players kept playing,
# their scores were queued in localStorage, and both leaderboards showed an
# empty table for ~26 hours. Last good write 2026-07-25 21:50:57Z.
#
# The index is now declared in schema.sql, so applying schema.sql to any
# database (including production) restores it:
#
#   npx wrangler d1 execute sixlets-db --remote --file=./schema.sql --yes
#
# Before dropping any index on a live database, confirm what constrains the
# table rather than inferring it from schema.sql:
#
#   npx wrangler d1 execute sixlets-db --remote \
#     --command "PRAGMA index_list('Results');"
#
# origin='u' is a table constraint; origin='c' is a created index. An index that
# is the only unique coverage of an upsert's conflict target is load-bearing, no
# matter how redundant it looks in the schema file.

cat <<'MSG'
  This script is retracted and does nothing.

  It dropped a load-bearing unique index and silently broke every result
  write for ~26 hours on 2026-07-25. See the comment block in this file and
  in sql/drop-redundant-indexes.sql.

  idx_results_user_game is required by the ON CONFLICT upsert in
  functions/api/results.js and is now declared in schema.sql.
MSG

exit 1
