# EntreLaços Decision Register

**Status:** Durable product decisions from the accepted interview dated 2026-09-09, including the Block 4 contract decisions recorded on 2026-09-12. This register is a concise companion to the PRD; it does not replace the interview record, architecture specification, validation record, or launch approvals.

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
| RSVP | Member states are exactly `PENDING`, `CONFIRMED`, and `DECLINED`. The authenticated representative answers for the group; partial responses and fully pending groups are valid; save is explicit; “confirm all” is a draft shortcut. A nullable deadline is represented by paired null instant/timezone; with both fields null, no deadline blocks RSVP. When configured, the server evaluates the UTC instant with an explicit IANA timezone for display. Guests can read but cannot write at or after the exact deadline; authorized admins can correct an active wedding after it. | Accepted |
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
- Block 4 RSVP uses the existing family bearer and site-namespaced `sessionStorage`; the API derives public site/group scope from the validated session. Member revisions, all-or-nothing transactions, request receipts, and separate history are API/database concerns. `wedding-features` owns reusable presentation only.
- Production deployment, domain/DNS work, main migrations, provider setup, and lifecycle status are manual operations recorded by the operator.

## Template/site planning refinement — 2026-09-12

The operator requested this [comparative study](../plans/entrelacos-template-site-study.md) and planning update. Existing managed-service and composition decisions remain accepted; the following implementation directions are scheduled for Blocks 6–8, not delivered by this documentation change:

- The template owns reusable layouts, sections, theme and preset composition; each wedding owns routes, public content, SEO inputs, media and local extensions.
- Keep `template-root` and `wedding-demo`. Establish a reviewed presentation `/v1` API in B6-T0 and migrate existing imports explicitly; no new design package is needed yet.
- Prove reuse with a normal demo and a second local composition with distinct identity/media/SEO, an extra page and a custom section. No permanent third environment is introduced.
- Keep guest behavior in `wedding-features` and operational authority in the API. Site customization cannot override authentication, deadlines, moderation or tenant isolation.
- Use operator-authored Astro composition; defer page builders, inheritance, plugin registries and CMS persistence.
- Track Git/build inputs and artifacts for independent releases; a workspace export suffix alone does not pin deployed source.

Exact section contracts/slots and client indexing intent remain B6 inputs. Demo/review noindex is the study's recommended default, not access control or an already implemented behavior. Existing visual/media/provider gates remain open.

## Block 4 implementation record — 2026-09-12

The `block-4/member-rsvp` working tree contains the RSVP schemas, migrations, service, HTTP router, admin section, and shared guest form/draft helpers. The frozen route and payload surface is recorded in [the Block 4 contract](./block4Contracts.md). Reviewed test/development migrations, real PostgreSQL tests, independent browser QA, static artifact scanning, and final gates passed on 2026-09-12; [the validation record](./block4Validation.md) contains the evidence and limits.

The operational choices checked before this record are: no deadline is allowed through a paired null value; a configured deadline rejects public writes at `serverNow >= deadlineAt`; a replay of an identical successful request is accepted even after the deadline; a changed payload with the same request ID is rejected; a stale submitted member rolls back the whole submission; omitted members do not conflict; history stores actor and display snapshots; and foreign groups remain administrative-only. The admin UI exposes deadline configuration, current totals/filters, and a separate history view. Any behavior that differs in executed validation must update this record and the contract before acceptance.

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

The template/site study preserves the reference repository's host/package ownership but expands the planned public section surface for local customization. Fixed-page-only reuse and a generic page builder were rejected; the follow-up is a two-consumer build proof before final visual work.

Block 4 keeps RSVP presentation in `packages/wedding-features` while leaving deadline, authorization, concurrency, persistence, and history in the API. A template or site may choose location and styling through the public feature seam, but static output cannot contain family data, sessions, responses, credentials, or operational fixtures. This preserves the Block 6 design boundary and keeps Block 5 reporting/messages from creating a second RSVP authority.
