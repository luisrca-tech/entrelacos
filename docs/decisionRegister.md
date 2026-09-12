# EntreLaços Decision Register

**Status:** Durable product decisions from the accepted interview dated 2026-09-09. This register is a concise companion to the PRD; it does not replace the interview record, architecture specification, or launch approvals.

## Confirmed product decisions

| Area | Decision | Status |
| --- | --- | --- |
| Service model | EntreLaços is a managed Brazilian wedding-site service. The operator creates, customizes, publishes, and maintains each site. | Accepted |
| Customer access | The central panel has global `OWNER` access and wedding-bound `SITE_ADMIN` access. There is no public signup. | Accepted |
| Site delivery | One independently deployed static site per wedding; shared changes affect newly built sites only. | Accepted |
| Guests | Groups are the unit of authorization. Group name is required, each group has at least one named member, one representative, and one wedding-scoped normalized Brazilian phone. | Accepted |
| Foreign numbers | Foreign-number groups may omit phone and use administrative RSVP only; no guest authentication, messages, or automatic SMS fallback. | Accepted |
| Guest verification | Full name plus registered phone locates the group. For the MVP, an administrator copies the persistent six-digit group PIN and shares it with the invitation link through an external channel. Twilio Verify remains configured as a future opt-in SMS channel, not an MVP dependency. Matching ignores case, accents, and extra spaces but rejects approximate or abbreviated names. | Accepted |
| Verification protection | A manual group PIN remains valid until explicit rotation, while each verification challenge lasts 10 minutes. Five declined codes cause a 15-minute cooldown, and lookup/verification limits use the numeric scopes recorded in the Block 3 contract. SMS-only flows retain the 60-second resend and send ceilings. | Accepted |
| Family session | Successful PIN or SMS verification creates a site-and-group-bound opaque bearer with seven-day absolute expiry. The browser keeps it only in site-namespaced `sessionStorage`; explicit leave, representative/phone changes, and PIN rotation revoke it server-side. | Accepted |
| RSVP | Member states are `PENDING`, `CONFIRMED`, and `DECLINED`. Representative answers for the group; partial pending is valid; deadline has explicit timezone; admins may correct after deadline. | Accepted |
| Messages | One text message per group, at most 1,000 characters, emojis/newlines allowed, no HTML/attachments. Representative may edit; admins may delete but never edit. | Accepted |
| Mural | Per-site toggle and per-group message block affect message writes only and retain data. Public output omits phone, member list, and RSVP. | Accepted |
| Exports | Wedding-scoped CSV and paginated printable PDF include selected RSVP/guest fields and exclude messages. | Accepted |
| Lifecycle | The first public deployment may occur before or during review with a warning not to share it. Review approval starts an editable one-year term. Deactivation is manual, shows a neutral public placeholder, preserves data, and keeps admin consultation/export read-only. | Accepted |
| Demo operation | Demo is a demo-marked site in an existing environment, with owner-authorized browser/phone simulation and manual reset limited to that site. There is no permanent third demo environment or database; a sentinel tenant must remain unchanged. | Accepted |
| Demo venue | The illustrative demo ceremony/reception venue is Casablanca Eventos, Av Ipanema 747, Jardim Atlantico, Goiania, GO 74343-010, with `https://casablancaeventosgoiania.com.br/contato` as the approved location link. | Accepted |
| Scope exclusions | Gifts, checkout, payments, uploads/object storage, integrated WhatsApp messaging, international SMS, individual guest accounts, secret links, self-service CMS, automatic provider/domain operations, and a permanent demo environment/database are out of MVP. Copying a PIN for manual delivery through WhatsApp does not integrate WhatsApp. | Accepted |

## Confirmed technical boundaries

- Public sites use Astro static builds on Cloudflare Workers Static Assets.
- The central panel uses TanStack Start on Cloudflare Workers.
- A Hono Node.js/TypeScript API on Railway is the sole business and database authority.
- PostgreSQL on Neon is shared and multi-tenant; development, main, and disposable test resources are separate.
- The monorepo uses Bun workspaces and Turborepo. Agreed boundaries include admin, API, demo site, template foundation, shared wedding behavior, UI, contracts, and database concerns.
- Drizzle, node-postgres, reviewed/manual SQL migrations, Better Auth, `/v1` JSON contracts, shadcn/Base UI, Sonner, and Motion for approved intro/text/story choreography are the current directions. CSS/Intersection Observer remain suitable for basic interactions.
- All authorization is server-side. Public frontends never access Neon. Allowed browser origins/CORS are explicit per wedding; wildcard CORS or authorization is forbidden.
- Production deployment, domain/DNS work, main migrations, provider setup, and lifecycle status are manual operations recorded by the operator.

## Superseded historical details

- Historical notes that made the group name optional are superseded. Current rule: group name required.
- Historical discovery material suggesting possible self-service, broader CMS, gifts, checkout, uploads, WhatsApp, or other future capabilities is not current scope.
- Visual references remain inspiration only. The provisional ivory/dark-olive serif cinematic direction, final brand, final logo, and final motion tokens are not approved design decisions.

## Open decisions and release gates

1. Commercial buyer, price, revision policy, cancellation, renewal, tolerance period, and support service levels. These are external business-policy decisions, not technical MVP blockers, but must be addressed for commercial operations.
2. Numeric monthly SMS ceiling default and owner alert/override policy before live SMS activation.
3. Cloudflare, Railway, Neon, CI, Twilio, and media-provider account ownership, credentials, permissions, region/country access, and costs.
4. The guest-to-API cross-origin transport is resolved as an exact-origin bearer flow using site-namespaced `sessionStorage`. The separate authenticated admin panel-to-public-site handoff design and its clean-browser proof remain open.
5. Privacy notice, retention schedule, data rights, deletion exceptions, client media permissions, and legal review.
6. Neon tier, retention/cost, backup strategy, and real restoration evidence for RPO at most one hour and RTO at most eight hours.
7. Final visual direction, logo/favicon, fictional-couple image approval, video provider/cost/rights, and image-to-video poster workflow.
8. Production domain/DNS responsibilities, custom-domain ownership and renewal, and worker-per-wedding scale response.

Open items must be marked pending or blocked in implementation evidence. A mock provider, placeholder media, owner-entered status, or local health response cannot be reported as proof that the corresponding external capability is live.

## Listening

The package-manager migration authorized on 2026-09-09 replaces the earlier package-manager choice with Bun 1.3.14 for all workspaces and CI. Node.js 24, Turborepo, Vitest, dependency version pins, and application boundaries remain unchanged. Isolated installs retain explicit workspace dependency boundaries and package-local CLI paths; a runtime or test-framework migration is outside this change.

Block 3 now selects a persistent six-digit group PIN for provider-free MVP delivery and keeps browser-tab-scoped guest persistence. A random database seed plus a domain-separated server HMAC derives the PIN; plaintext PIN storage and an offline-brute-forceable plain hash were rejected. `localStorage`, cross-site cookies, URL tokens, and a custom refresh-token system remain rejected because the seven-day server record already supplies the absolute lifetime while `sessionStorage` reduces browser persistence and cross-site credential coupling.
