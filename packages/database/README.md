# Database foundation

Server-only Drizzle/node-postgres connection and migration boundary. Importing this package does not open a connection. The API composition root owns the pool lifetime. Never import this package from admin or public apps.

The operator will supply separate Neon connections for development and main. Integration tests require a distinct disposable resource, not either of those databases. Do not copy production PII into test branches.

Set development and test connections and verified expected resource identities in the ignored `.env` in this package. Generate SQL offline, review it, then select an authorized destination explicitly:

```sh
bun run --cwd packages/database db:generate
bun run --cwd packages/database db:migrate --target=test
# Only after the test migration and its integration checks pass:
bun run --cwd packages/database db:migrate --target=development
bun run test:db
```

The migration runner accepts only `test` and `development` and verifies the server-reported identity before applying SQL. Test selection requires `DATABASE_URL_TEST`; it never falls back to development. The dedicated integration suite fails when the destination cannot be verified. It does not run migrations automatically. Cleanup is limited to identified fixtures, never an unscoped table reset. Production migrations are outside this runner and require a separate authorized procedure. See `docs/block2Validation.md` for actual completion evidence.

## Listening

Expected Neon identities supplement URL checks because pooled and direct endpoints can refer to the same branch. SQL logging is disabled to avoid logging credential-bearing parameters or literals. Explicit migration targets replace the scaffold's ambient connection selection.
