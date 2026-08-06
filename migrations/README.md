# migrations/

Forward-only, numbered SQL. Apply in filename order; never edit a file that has
already been applied to production — add a new one.

```bash
# preview first (--preview resolves preview_database_id from wrangler.toml)
npm run db:migrate:preview

# then production
npm run db:migrate
```

Both go through `wrangler d1 execute sixlets-db`, selecting the preview
database with `--preview` rather than by name — the preview database is wired
to this project through `preview_database_id` in `wrangler.toml`, not through a
second `[[d1_databases]]` block, so `--preview` is what keeps the two in step
if that id ever changes.

## Why this directory exists

`schema.sql` is `CREATE TABLE IF NOT EXISTS` throughout, which **cannot alter an
existing table**. On 2026-07-25 that gap cost ~26 hours of unrecorded results:
`schema.sql` declared `UNIQUE(user_uuid, game_id)` on `Results`, production's
table predated the line, `IF NOT EXISTS` skipped it silently, and an index was
dropped as "redundant with a constraint" production never had. See the incident
write-up in `CODE_REVIEW.md`, whose closing line is that a migrations directory
would have caught it.

So the rule is:

- **`migrations/NNNN_*.sql`** is what actually changes a live database. It may
  contain `ALTER TABLE`, `UPDATE`, backfills — anything.
- **`schema.sql`** stays idempotent and describes the intended end state, so a
  database created from scratch converges with one that got there by migration.
  Every migration that adds a table or index must also be reflected there.

A schema change therefore touches two files. That is the point: neither one
alone tells you what production looks like.

## Verifying, rather than assuming

"Applied to production" is a claim about a command, not about the database.
Confirm the result:

```bash
npx wrangler d1 execute sixlets-db --remote \
  --command="SELECT name FROM sqlite_master WHERE name LIKE 'Admin%' ORDER BY name;"
```

## Order relative to deploys

**Migrations first, then deploy, chained with `&&`.** New code selects columns
that do not exist yet; a deploy that outruns its schema returns 500 on every
affected route while the static pages render perfectly, so the site looks up.
The reverse order — schema ahead of code — is safe, because nothing reads the
new columns yet.

If a `--remote` command fails with **error 7403** ("the given account is not
valid or is not authorized to access this service"), run `wrangler login`. It
reads like a billing or permissions problem and it is a stale OAuth token.
`wrangler whoami` will not help: it prints the scopes recorded in the local
config file at last login, not what the token currently grants, so it will
happily confirm a `d1 (write)` the token no longer carries.
