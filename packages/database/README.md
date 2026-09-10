# Database foundation

Server-only Drizzle/node-postgres dependency boundary and migration configuration. No business tables or migrations exist yet. Importing this package does not open a connection. The API will create its connection pool during the persistence block. Never import this package from admin or public apps.

The operator will supply separate Neon connections for development and main. Integration tests require a distinct disposable resource, not either of those databases. Do not copy production PII into test branches.

After the first reviewed schema is implemented, set `DATABASE_URL` in an ignored `.env` in this package and run from the repository root:

```sh
bun run --filter @entrelacos/database db:generate
bun run --filter @entrelacos/database db:migrate
```

These commands use the selected connection without inferring its environment. Inspect the destination before running; production execution is manual. Do not run `db:migrate` against main as part of CI or server startup. An empty scaffold schema is not a migration plan. All access, schema and irreversible execution checks belong to the persistence task preflight.
