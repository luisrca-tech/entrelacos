# Block 2 panel and public-site integration

The panel runs the real TanStack Start application on Workers. Its `/api/$`
server route forwards to the fixed `API_BASE_URL`; `ADMIN_ORIGIN` must match the
panel's actual origin. Both settings are server-only. Local Vite development
reads `.dev.vars`; start from `.dev.vars.example`. The API independently checks
the panel Origin and the authenticated actor.

The panel provides `/login`, `/activate`, `/recover`, `/`, `/sites/:siteId`, and
`/handoff`. An OWNER starts at the wedding chooser; a SITE_ADMIN starts with the
assigned wedding. Owner controls cover creation, lifecycle, dates, publication
records, trusted origins, domains, and administrative access. An inactive
wedding remains readable and keeps its data. Guest operations and exports belong
to later implementation blocks.

The static wedding app uses `PUBLIC_SITE_ID`, `PUBLIC_API_URL`, and
`PUBLIC_ADMIN_ORIGIN` at build time. Register its exact origin through the owner
API before testing administrative recognition. Ordinary visitors see the site
without an authentication redirect. The Panel link opens the central panel
directly. Opening the public site from the panel starts a challenge-bound round
trip; the return carries a one-use code in a fragment.
When the panel itself is opened on a loopback host (`localhost`, `127.0.0.1`,
or `[::1]`), **Ir para o site** uses `http://localhost:4321/#panel` instead of
the stored public URL. When the API request is also loopback, public CORS and
handoff accept loopback origins without inserting them into `site_origin`.
Development and production deploys keep the registered public URL and still
require an exact registered origin.
The public app stores only a narrow recognition token in session storage and
sends API requests without cookies. Polling every five seconds rechecks the
parent session and does not extend its idle deadline. The token cannot read
administrative business endpoints. Refresh preserves recognition within its
15-minute lifetime; logout, disable, recovery, or expiry removes recognition on
the next check.

`PUBLIC_SITE_INACTIVE=true` produces a neutral static page. This flag is a
build/deployment operation, separate from the API's lifecycle and publication
records. Follow `block2Lifecycle.md` for every hostname, including `workers.dev`.

## Listening

The selected transport keeps the administrative cookie first-party in the
panel and exchanges a short-lived, site-bound proof for public recognition.
This preserves the static Astro deployment and avoids putting an administrative
session into the public site. Browser emulation validates responsive behavior;
Safari is an additional, non-blocking test separately recorded in `block2Validation.md`.
