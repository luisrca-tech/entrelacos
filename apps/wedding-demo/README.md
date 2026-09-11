# `@entrelacos/wedding-demo`

Minimal public Astro site that consumes the shared template layout and section package. It demonstrates static composition, hydrated React feature-status and administrative recognition islands, Motion's reduced-motion-aware boundary, and no product workflow simulation.

## Commands

- `bun run dev` starts the local Astro server through the workspace task.
- `bun run build` generates the static site in `dist/`.
- `bun run typecheck` runs Astro's strict type checker.
- `bun run preview` serves the generated static output locally.

`wrangler.jsonc` points Cloudflare Workers Static Assets at `./dist`. It intentionally has no deploy script, account credentials, or provider bindings. Deploy and domain setup remain manual infrastructure work.

## Local configuration

The administrative recognition integration consumes these public build-time values:

```sh
PUBLIC_API_URL=http://localhost:8080
PUBLIC_ADMIN_ORIGIN=http://localhost:3000
PUBLIC_SITE_ID=demo-wedding
PUBLIC_SITE_INACTIVE=false
```

Provision the wedding through the owner API and register its exact origin before using recognition. `PUBLIC_SITE_ID` identifies the wedding; it grants no authorization. Set `PUBLIC_SITE_INACTIVE=true` and rebuild to generate the neutral static page; deploy that artifact to every served hostname as described in `docs/block2Lifecycle.md`.

The Astro config enables Tailwind CSS through the Vite plugin. `src/styles/tailwind.css` is the single entry point for Tailwind, shared UI tokens, and the local workspace source scan.
