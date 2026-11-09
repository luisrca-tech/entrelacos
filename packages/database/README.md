# Database foundation

Server-only Drizzle/node-postgres connection and migration boundary. Importing this package does not open a connection. The API composition root owns the pool lifetime. Never import this package from admin or public apps.

## Local development and tests

Run these commands from the repository root.

```sh
cp -n packages/database/.env.example packages/database/.env
docker compose up -d --wait
bun run db:migrate
bun run test:db
```

Compose runs `entrelacos_dev` on port 55432 with a named volume and `entrelacos_test` on port 55433 with temporary storage. The API uses the development database. Integration tests verify the test database and apply pending migrations before running. Use synthetic data for local development. `docker compose stop` stops both databases, preserves development data and clears test data.

`bun run db:generate` generates SQL offline. Review the SQL before applying it. `bun run db:migrate` uses `DATABASE_DIRECT_URL` and checks that it matches the host and database in `DATABASE_URL` when both are set. Remote connections require verified TLS. For Neon-specific checks against a dedicated test branch, supply explicit test credentials and apply reviewed migrations to that branch separately.

## Deployment migrations

Database CD runs on pushes to `development` and `main`. It waits for validation against a disposable PostgreSQL service, then runs migrations in the matching GitHub environment.

| Git branch | GitHub environment |
| --- | --- |
| `development` | `development` |
| `main` | `production` |

Restrict each GitHub environment to its branch. In each environment, set the `DATABASE_URL` secret to the API connection URL, the `DATABASE_DIRECT_URL` secret to the direct migration-role URL, and the `DATABASE_MIGRATION_HOST` variable to the exact unpooled Neon hostname for that environment.

Enable **Wait for CI** on the Railway API services connected to these branches so automatic deploys wait for the migration workflow. Keep migrations compatible with the currently running API during rollout. A manual deployment outside this workflow requires verifying that its migrations have already succeeded.

Migration `0010_invitation_model` intentionally stops if any legacy invitation-domain table still contains rows. That failure requires checking the selected database and making an explicit data-retention decision; running `db:generate` again will not clear it, and `db:migrate` must not silently delete data.

## Listening

The routine test suite uses local PostgreSQL so it runs on pull requests without Neon credentials or quota. The release workflow checks an independently configured Neon hostname because two matching connection URLs can still point to the wrong environment.
