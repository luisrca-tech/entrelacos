# Database foundation

Server-only Drizzle/node-postgres connection and migration boundary. Importing this package does not open a connection. The API composition root owns the pool lifetime. Never import this package from admin or public apps.

The operator will supply separate Neon connections for development and main. Integration tests require a distinct disposable resource, not either of those databases. Do not copy production PII into test branches.

Set `DATABASE_URL` (and, for integration tests, `DATABASE_URL_TEST` plus verified identities) in the ignored `.env` in this package. Run these Drizzle Kit commands from the repository root. Generate SQL offline, review it, then apply it to whatever database `DATABASE_URL` currently points at:

```sh
bun db:generate
bun db:migrate
bun run test:db
```

The root scripts delegate to this package, so Drizzle Kit finds its configuration, migration files, and ignored `.env`. `db:generate` does not require a database connection. `db:migrate` reads only `DATABASE_URL`, enforces `sslmode=verify-full`, and applies the reviewed SQL with Drizzle Kit. It does not take a target flag or verify Neon branch/project identity before applying SQL: confirm the configured destination before running it. The dedicated integration suite uses `DATABASE_URL_TEST` and still verifies destination identity. It does not run migrations automatically. Cleanup is limited to identified fixtures, never an unscoped table reset. See `docs/block2Validation.md` for earlier completion evidence.

Migration `0010_invitation_model` intentionally stops if any legacy invitation-domain table still contains rows. That failure requires checking the selected database and making an explicit data-retention decision; running `db:generate` again will not clear it, and `db:migrate` must not silently delete data.

## Listening

Expected Neon identities still guard runtime and test connections because pooled and direct endpoints can refer to the same branch. SQL logging is disabled in the application connection. Drizzle Kit now generates and applies migrations directly; a second application migrator added no needed behavior and hid migration errors. Migration execution still follows the configured `DATABASE_URL`, so destination selection remains a manual operator responsibility.
