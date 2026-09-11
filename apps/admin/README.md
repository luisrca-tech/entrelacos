# `@entrelacos/admin`

Central TanStack Start/React panel on Cloudflare Workers. Block 2 provides
controlled login, activation/recovery, an OWNER wedding chooser, a scoped
SITE_ADMIN view, lifecycle and access controls, and administrative site handoff.

Copy `.dev.vars.example` to the ignored `.dev.vars` for local Vite execution.
`API_BASE_URL` selects the fixed backend; `ADMIN_ORIGIN` must exactly match the
browser origin. Both values are server-only. The API must be running with the
same admin origin and a verified database target. No database code runs here.

## Routes and commands

Routes: `/`, `/login`, `/activate`, `/recover`, `/sites/:siteId`, `/handoff`,
and the server-only `/api/$` BFF. Activation/recovery links carry their manual
one-use token in the fragment; successful consumption still requires login.

Use `bun run dev`, `bun run build`, `bun run typecheck`, or `bun run preview`.
`bun run deploy` builds and invokes Wrangler only when publication is explicitly
authorized; provider accounts, domains, and secrets remain external settings.

TanStack Router generates `src/routeTree.gen.ts`. See `docs/block2Panel.md` and
`docs/block2Validation.md` from the repository root for transport and evidence.
