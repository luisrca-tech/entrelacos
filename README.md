# EntreLaços

Managed wedding websites in a TypeScript Turborepo. The product interview is complete; this repository contains its requirements, engineering contracts, implementation blocks and an executable foundation.

**Current scope: scaffold.** Liveness and placeholder pages run without provider credentials. Authentication, wedding persistence, provisioning, RSVP, messages, exports, production media and finished design remain implementation tasks. Installing Better Auth or Drizzle does not mean those features are wired.

## Read first

1. [PRD and user stories](plans/entrelacos-prd.md)
2. [Accepted decisions and superseded assumptions](docs/decisionRegister.md)
3. [Architecture and API boundaries](docs/architecture.md)
4. [Implementation blocks and task preflight](plans/entrelacos-implementation-plan.md)
5. [Infrastructure, tools and credentials](docs/infrastructure.md)
6. [Validation evidence and limitations](docs/scaffoldValidation.md)
7. [Historical inputs](docs/references/README.md)

## Prerequisites and commands

Use Node.js 24 and Bun 1.3.14 (pinned in `packageManager`). No Neon, Twilio, Cloudflare or Railway credentials are needed for scaffold checks.

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

Install the pinned Bun version using the [official installation instructions](https://bun.sh/docs/installation). Bun is the only package manager; Node.js 24 remains the runtime for the API and Node-based tooling. Use `bun run test` to invoke Vitest.

| Surface | Local URL | Purpose |
| --- | --- | --- |
| Central panel | `http://localhost:3000` | Navigable TanStack Start scaffold; login unavailable |
| API | `http://localhost:3001/v1/health` | Hono liveness without database access |
| Wedding demo | `http://localhost:4321` | Astro consuming the reusable template foundation |

Run individual apps with `bun run --filter @entrelacos/admin dev`, `bun run --filter @entrelacos/api dev` or `bun run --filter @entrelacos/wedding-demo dev`.

`bun run lint`, `bun run typecheck`, `bun run test` and `bun run build` are separate checks. `bun run check` runs all four. Biome handles supported source formats; Astro performs its own syntax/type validation. Production database/browser acceptance suites are planned and must not be confused with scaffold tests. CI runs the same credential-free checks; it does not deploy or migrate main.

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

Use separate Neon `development` and `main` connections. Real client media may be developed locally. The demo is a scoped wedding in each environment, not a third permanent environment. Disposable integration resources are separate from both. `.env.example` files are placeholders; values are not loaded or honored by integrations that do not yet exist.

Never commit `.env`, `.dev.vars`, tokens or connection strings. Never place server secrets in `PUBLIC_*` or `VITE_*`. User-entered status does not verify external hosting state. Infrastructure, production migrations, publication and domain actions remain manual. Read each task's prerequisites before connecting live services.

## Listening

This delivery builds executable boundaries and records the complete intended product without pretending that placeholder screens implement authentication or RSVP. Shared packages export source for application bundlers; the API emits runnable ESM. Bun 1.3.14 is the sole package manager. Workspaces and trusted dependency lifecycle scripts are declared in the root manifest; `bunfig.toml` keeps exact version saves and isolated dependency linking. The text `bun.lock` is the only dependency lockfile. Node.js 24 and Vitest remain in place because this migration changes package management, not application runtimes or the test framework. Art direction, media generation, secure cross-domain sessions and recovery capacity need their documented validation gates.
