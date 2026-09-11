# `@entrelacos/wedding-demo`

Minimal public Astro site that consumes the shared template layout and section package. It demonstrates static composition, one hydrated React feature-status island, Motion's reduced-motion-aware boundary, and no product workflow simulation.

## Commands

- `bun run dev` starts the local Astro server through the workspace task.
- `bun run build` generates the static site in `dist/`.
- `bun run typecheck` runs Astro's strict type checker.
- `bun run preview` serves the generated static output locally.

`wrangler.jsonc` points Cloudflare Workers Static Assets at `./dist`. It intentionally has no deploy script, account credentials, or provider bindings. Deploy and domain setup remain manual infrastructure work.

## Local configuration

The future public API integration uses the following browser-safe values:

```sh
PUBLIC_API_URL=http://localhost:8080
PUBLIC_SITE_ID=demo-wedding
```

These variables are reserved configuration examples and are not consumed by the current liveness scaffold. `PUBLIC_SITE_ID` identifies the demo site; it does not grant authorization.

The Astro config enables Tailwind CSS through the Vite plugin. `src/styles/tailwind.css` is the single entry point for Tailwind, shared UI tokens, and the local workspace source scan.
