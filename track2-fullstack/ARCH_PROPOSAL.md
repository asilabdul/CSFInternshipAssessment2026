# Architecture Proposal: Schema Migrations and Data Lifecycle

## Problem

FarmTracker currently creates schema inside `db.js` with `CREATE TABLE IF NOT EXISTS`. That keeps setup simple, but it makes database changes difficult to reason about once a user has an existing SQLite file. If a column, constraint, index, or table changes, there is no version history, no repeatable upgrade path, and no way for tests or production setup to prove that the schema is current. The repository also previously tracked SQLite database files, which can mask setup problems and cause binary-file churn in reviews.

## Proposed Direction

Introduce a lightweight migration runner that keeps the existing Node.js and SQLite stack:

1. Add `backend/migrations/` with ordered SQL files such as `001_initial_schema.sql` and `002_add_weights.sql`.
2. Add a `schema_migrations` table with `version`, `name`, and `applied_at` columns.
3. Replace `initDb()` table definitions with a runner that:
   - starts a transaction,
   - reads migration files in lexical order,
   - skips versions already present in `schema_migrations`,
   - applies pending SQL,
   - records each successful migration,
   - rolls back on failure.
4. Keep `seed.js` separate from migrations. Seeds should only create sample data for local development and tests.
5. Keep SQLite database files ignored and generated locally via `node seed.js`.

## Execution Plan

For the next iteration, first extract the current schema into `001_initial_schema.sql`, then move the new `weights` table into `002_add_weights.sql`. Update tests to create a temp database and run migrations before seeding, exactly as they do now through `initDb()`. After that, add migration coverage for fresh databases and existing databases with only migration `001` applied.

This keeps the assessment changes reviewable while giving the app a clear path for future schema evolution.
