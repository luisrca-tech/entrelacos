# EntreLaços

Managed wedding websites in a TypeScript Turborepo. The product interview is complete; this repository contains its requirements, engineering contracts, implementation blocks and an executable foundation.

**Current scope:** controlled administration, invitations with one or more adult/child guests, required contact phone and optional email, site-scoped phone plus six-digit PIN access, invitation sessions, individual RSVP, messages, mural, CSV/PDF reports, demo reset, and reusable wedding presentation. SMS delivery and Twilio integration are not product dependencies.

## Read first

1. [PRD and user stories](plans/entrelacos-prd.md)
2. [Accepted decisions and superseded assumptions](docs/decisionRegister.md)
3. [Architecture and API boundaries](docs/architecture.md)
4. [Implementation blocks and task preflight](plans/entrelacos-implementation-plan.md)
5. [Infrastructure, tools and credentials](docs/infrastructure.md)
6. [Block 2 validation](docs/block2Validation.md) and [Block 3 handoff](docs/block2Handoff.md)
7. [Historical inputs](docs/references/README.md)

## Prerequisites and commands

Use Node.js 24 and Bun 1.3.14 (pinned in `packageManager`). Credential-free checks need no provider access. Running the API requires the guarded Neon development/test configuration and an auth secret. The database suite requires the isolated test connection.

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

Install the pinned Bun version using the [official installation instructions](https://bun.sh/docs/installation). Bun is the only package manager; Node.js 24 remains the runtime for the API and Node-based tooling. Use `bun run test` to invoke Vitest.

| Surface | Local URL | Purpose |
| --- | --- | --- |
| Central panel | `http://localhost:3000` | First-party BFF, controlled login and wedding operations |
| API | `http://localhost:8080/v1/health` | Hono API; startup verifies database identity |
| Wedding demo | `http://localhost:4321` | Astro consuming the reusable template foundation |

Run individual apps with `bun run --filter @entrelacos/admin dev`, `bun run --filter @entrelacos/api dev` or `bun run --filter @entrelacos/wedding-demo dev`.

`bun run lint`, `bun run typecheck`, `bun run test` and `bun run build` are separate checks. `bun run check` runs all four. Biome handles supported source formats; Astro performs its own syntax/type validation. `bun run test:db` runs the real, serialized PostgreSQL acceptance suite against the verified test branch. CI runs the same credential-free checks; it does not deploy or migrate main.

Use `bun db:generate` to generate a migration without connecting to a database, then review its SQL. Use `bun db:migrate` to apply reviewed migrations to the database selected by `packages/database/.env` (or an explicit `DATABASE_URL` in the shell). The migration command does not infer development versus production; see the [database operations guide](packages/database/README.md) before running it.

## Workspace

```text
apps/
  admin/             Central TanStack Start app, Cloudflare Workers
  api/               Hono Node.js API, Railway
  wedding-demo/      Astro static demonstration app
packages/
  template-root/     Reusable editorial composition and default theme
  wedding-features/  Shared guest-facing feature presentation/integration
  ui/                shadcn/Base UI primitives and Sonner
  contracts/         Public API types and runtime schemas
  database/          Server-only Drizzle/PostgreSQL foundation
docs/                Contracts, decisions, operations and historical inputs
plans/               PRD and implementation blocks
```

New client apps compose `template-root`; they do not receive a copied template or a new backend. Each wedding has independent assets, configuration and deployment. Only the API and authorized backend operations access the database package.

## Environment and operational rules

Use separate Neon `development` and `main` connections. Real client media may be developed locally. The demo is a scoped wedding in each environment, not a third permanent environment. Disposable integration resources are separate from both. Copy the relevant `.env.example`/`.dev.vars.example` files into ignored local configuration. See each app README for consumed settings.

Never commit `.env`, `.dev.vars`, tokens or connection strings. Never place server secrets in `PUBLIC_*` or `VITE_*`. User-entered status does not verify external hosting state. Infrastructure, production migrations, publication and domain actions remain manual. Read each task's prerequisites before connecting live services.

## Listening

Block 2 connects the administrative product path while keeping guest workflows for Block 3 and later blocks. Shared packages export source for application bundlers; the API emits runnable ESM. Bun 1.3.14 is the sole package manager. Workspaces and trusted dependency lifecycle scripts are declared in the root manifest; `bunfig.toml` keeps exact version saves and isolated dependency linking. The text `bun.lock` is the only dependency lockfile. Node.js 24 and Vitest remain in place because this migration changes package management, not application runtimes or the test framework. The panel cookie remains first-party; the public static site receives only short-lived recognition. Hosting and domain publication remain separate manual operations.
