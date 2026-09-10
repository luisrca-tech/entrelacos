# `@entrelacos/admin`

Central admin panel scaffold for EntreLaços, built with TanStack Start, React, Vite, and Cloudflare Workers.

This package is intentionally a working shell. It has no authentication, authorization, API calls, persistence, or product data. The login page is a visual placeholder and does not accept credentials.

## Routes

- `/` — scaffold overview with the planned OWNER and site operational boundaries.
- `/login` — non-functional login placeholder.

## Commands

```sh
bun run dev
bun run build
bun run typecheck
bun run preview
bun run cf-typegen
bun run deploy
```

`bun run deploy` builds and invokes Wrangler. Cloudflare account, domain, and secrets remain external deployment configuration; none are stored in this package.

TanStack Router writes `src/routeTree.gen.ts` during development or build. It is generated source and may be replaced when routes change.
