# Database foundation

Server-only Drizzle/node-postgres connection and migration boundary. Importing this package does not open a connection. The API composition root owns the pool lifetime. Never import this package from admin or public apps.

The operator will supply separate Neon connections for development and main. Integration tests require a distinct disposable resource, not either of those databases. Do not copy production PII into test branches.

Set `DATABASE_URL` (and, for integration tests, `DATABASE_URL_TEST` plus verified identities) in the ignored `.env` in this package. Generate SQL offline, review it, then apply it to whatever database `DATABASE_URL` currently points at:

```sh
bun run --cwd packages/database db:generate
bun run --cwd packages/database db:migrate
bun run test:db
```

`db:migrate` reads only `DATABASE_URL`. It does not take a target flag and does not verify Neon branch or project identity before applying SQL. The dedicated integration suite uses `DATABASE_URL_TEST` and still verifies destination identity. It does not run migrations automatically. Cleanup is limited to identified fixtures, never an unscoped table reset. See `docs/block2Validation.md` for actual completion evidence.

## Listening

Expected Neon identities still guard runtime and test connections because pooled and direct endpoints can refer to the same branch. SQL logging is disabled to avoid logging credential-bearing parameters or literals. The migration runner follows the configured `DATABASE_URL` instead of an environment target, so the same command works against whichever database that URL names.
