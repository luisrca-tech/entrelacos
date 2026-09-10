# API scaffold

Hono on Node.js 24, intended for Railway. `GET /v1/health` is liveness only. Unknown/unimplemented routes return a structured 404. No database, authentication, SMS or administrative operation is wired yet. Better Auth and its Drizzle adapter are installed dependencies for the authentication block; their presence is not an implemented login.

From the repository root:

```sh
bun run --filter @entrelacos/api dev
bun run --filter @entrelacos/api build
bun run --filter @entrelacos/api start
```

Default port: 3001. `.env` is optional for liveness. Copy `.env.example` only when preparing the corresponding integration task. Do not supply real secrets to frontend environment files. No CORS policy or business routes exist yet: these arrive with authenticated tenant boundaries, not an open wildcard.

Railway setup is manual: use the repository root as build context, a workspace-filtered build/start, and this health endpoint. Root lockfile and workspace packages are required; deploying only this subdirectory without dependencies is unsupported. Bind the service port through Railway's `PORT`. Production database migrations are a separate operator action, never part of server startup.
