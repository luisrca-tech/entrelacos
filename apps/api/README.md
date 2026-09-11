# API

Hono on Node.js 24. Better Auth and database access stay in this application; the panel forwards requests through its server-side BFF.

From the repository root:

```sh
bun run --cwd apps/api dev
bun run --cwd apps/api build
bun run --cwd apps/api start
```

The dev/start scripts load the private `packages/database/.env` first and `apps/api/.env` second. Keep database URLs and expected Neon identities in the database environment file. Configure the API environment using `.env.example`; never put server secrets in frontend variables.

`APP_ENV` must explicitly be `development` or `test`. The latter selects only `DATABASE_URL_TEST`, with no development fallback. Startup verifies the actual database identity before opening the HTTP listener. It does not run migrations. Production is intentionally not a selectable destination in this implementation phase.

`GET /v1/health` reports liveness only, not provider or business readiness. Its isolated handler tests require no credentials. Starting the complete server requires valid runtime settings and a verified database. The default port is 8080.

The browser can reach login, logout, and the current-user endpoint through the panel's `/api/v1/` BFF. Only explicitly mounted auth routes are available; the unrestricted native Better Auth handler is not exposed. Block 2 implementation and completed acceptance evidence are recorded in `docs/block2Validation.md`.

Railway setup and production migrations remain separate operator actions. Use the repository root as the eventual build context; deploying this subdirectory without workspace dependencies is unsupported.

## Listening

The runtime now selects and verifies a database explicitly, while the liveness handler remains independently testable. Database URLs are loaded from the existing central private file to avoid duplicating credentials across applications. Production configuration is reserved for the deployment block rather than guessed from development defaults.
