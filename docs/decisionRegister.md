# EntreLaços Decision Register

**Status:** Durable product decisions from the accepted interview dated 2026-09-09, as amended by the invitation-model decision on 2026-09-22. Block implementation records below describe their state at the time; where they mention groups, representatives, foreign-number exceptions, or SMS, the invitation-model decision supersedes them. This register does not replace the architecture specification, validation record, or launch approvals.

## Confirmed product decisions

| Area | Decision | Status |
| --- | --- | --- |
| Service model | EntreLaços is a managed Brazilian wedding-site service. The operator creates, customizes, publishes, and maintains each site. | Accepted |
| Customer access | The central panel has global `OWNER` access and wedding-bound `SITE_ADMIN` access. There is no public signup. | Accepted |
| Site delivery | One independently deployed static site per wedding; shared changes affect newly built sites only. | Accepted |
| Invitations | The invitation is the authorization and contact unit: required identification, required unique site-scoped phone, optional validated email, and at least one named guest. One guest is an individual invitation; multiple guests make it a group invitation. Guests are `ADULT` or `CHILD`; there is no representative. | Accepted 2026-09-22 |
| Phone numbers | The UI accepts Brazilian national numbers by default and international numbers with `+`; the API stores validated E.164. There is no country selector or foreign-number exception. | Accepted 2026-09-22 |
| Guest verification | A site-scoped phone and persistent six-digit invitation PIN establish access. The operator shares the PIN externally; no full-name lookup, SMS delivery, simulation, or provider integration is part of this flow. | Accepted 2026-09-22 |
| Verification protection | An invitation PIN remains valid until explicit rotation. Failed attempts are limited without disclosing whether a phone exists. There is no resend operation. | Accepted 2026-09-22 |
| Invitation session | Successful verification creates a site-and-invitation-bound opaque bearer with seven-day absolute expiry. The browser keeps it only in site-namespaced `sessionStorage`; explicit leave, invitation identity changes, and PIN rotation revoke it server-side. | Accepted 2026-09-22 |
| RSVP | Guest states are exactly `PENDING`, `CONFIRMED`, and `DECLINED`. An authenticated invitation session may answer for its guests; partial responses and fully pending invitations are valid; save is explicit; “confirm all” is a draft shortcut. A nullable deadline is represented by paired null instant/timezone; with both fields null, no deadline blocks RSVP. When configured, the server evaluates the UTC instant with an explicit IANA timezone for display. Guests can read but cannot write at or after the exact deadline; authorized admins can correct an active wedding after it. | Accepted 2026-09-22 |
| Messages | Each public submission creates a separate site-owned plain-text message of at most 1,000 characters. The visitor supplies an unverified name; no public edit is available. Admins may delete but never edit. | Accepted 2026-09-24; supersedes invitation-owned message rule |
| Mural | Public visitors submit independent site-scoped messages with a self-declared name. Names are not unique or matched to invitations. Administrators delete individual messages; the site switch and application rate limits control publication. See [publicMural.md](./publicMural.md). | Accepted 2026-09-24; supersedes invitation-owned message rule |
| Exports | Site-scoped CSV and paginated PDF contain one row or entry per guest, respect active search/status/type filters, and exclude messages, PINs, tokens, and internal IDs. Phone and email are opt-in export fields, off by default. There is no import. | Accepted 2026-09-22 |
| Lifecycle | The first public deployment may occur before or during review with a warning not to share it. Review approval starts an editable one-year term. Deactivation is manual, shows a neutral public placeholder, preserves data, and keeps admin consultation/export read-only. | Accepted |
| Demo operation | Demo is a demo-marked site in an existing environment and uses the same invitation PIN-only flow as every wedding. Manual reset is limited to that site. There is no permanent third demo environment or database; a sentinel tenant must remain unchanged. | Accepted |
| Demo venue | The illustrative demo ceremony/reception venue is Casablanca Eventos, Av Ipanema 747, Jardim Atlantico, Goiania, GO 74343-010, with `https://casablancaeventosgoiania.com.br/contato` as the approved location link. | Accepted |
| Scope exclusions | Gifts, checkout, payments, uploads/object storage, integrated outbound messaging, individual guest accounts, secret links, self-service CMS, automatic provider/domain operations, and a permanent demo environment/database are out of MVP. Copying a PIN through WhatsApp does not integrate WhatsApp. | Accepted |

## Confirmed technical boundaries

- Public sites use Astro static builds on Cloudflare Workers Static Assets.
- The central panel uses TanStack Start on Cloudflare Workers.
- A Hono Node.js/TypeScript API on Railway is the sole business and database authority.
- PostgreSQL on Neon is shared and multi-tenant; development, main, and disposable test resources are separate.
- The monorepo uses Bun workspaces and Turborepo. Agreed boundaries include admin, API, demo site, template foundation, shared wedding behavior, UI, contracts, and database concerns.
- Drizzle, node-postgres, reviewed/manual SQL migrations, Better Auth, `/v1` JSON contracts, shadcn/Base UI, and Sonner remain current directions. Block 6 uses Lenis plus CSS/Intersection Observer for its approved scrolling and restrained public motion; no Motion dependency was needed for this implementation.
- All authorization is server-side. Public frontends never access Neon. Allowed browser origins/CORS are explicit per wedding; wildcard CORS or authorization is forbidden.
- RSVP uses the invitation bearer and site-namespaced `sessionStorage`; the API derives public site/invitation scope from the validated session. Guest revisions, all-or-nothing transactions, request receipts, and separate history are API/database concerns. `wedding-features` owns reusable presentation only.
- Production deployment, domain/DNS work, main migrations, provider setup, and lifecycle status are manual operations recorded by the operator.

## Invitation-model amendment — 2026-09-22

The current admin surface is one `/sites/:siteId/invitations` page combining invitations and confirmations. It uses one “Adicionar Convite” flow, a guest list in the invitation form, search by invitation identification, status/type filters, a confirmations/history dialog, and CSV/PDF export. Old group, guest, RSVP, and overview admin pages are removed without redirects. Tags, tables, automatic reminders, guest promotion, and import are outside this amendment.

The SQL migration fails before changing schema if legacy operational rows remain; there is no backfill because the operator will clear pre-production data. This local implementation has not run the migration against a database and is not a release or production approval. The dated Block 3–7 contracts, validation records, and implementation notes below remain historical evidence, not current API or product authority where they conflict with this amendment.

## Template/site planning refinement — 2026-09-12

The operator requested this [comparative study](../plans/entrelacos-template-site-study.md) and planning update. Existing managed-service and composition decisions remain accepted; the following implementation directions are scheduled for Blocks 6–8, not delivered by this documentation change:

- The template owns reusable layouts, sections, theme and preset composition; each wedding owns routes, public content, SEO inputs, media and local extensions.
- Keep `template-root` and `wedding-demo`. Establish a reviewed presentation `/v1` API in B6-T0 and migrate existing imports explicitly; no new design package is needed yet.
- Prove reuse with a normal demo and a second local composition with distinct identity/media/SEO, an extra page and a custom section. No permanent third environment is introduced.
- Keep guest behavior in `wedding-features` and operational authority in the API. Site customization cannot override authentication, deadlines, moderation or tenant isolation.
- Use operator-authored Astro composition; defer page builders, inheritance, plugin registries and CMS persistence.
- Track Git/build inputs and artifacts for independent releases; a workspace export suffix alone does not pin deployed source.

At the time of the study, exact section contracts/slots and client indexing intent remained B6 inputs. The Block 6 implementation record below supersedes that planning-state description. Existing final media/provider/rights/cost gates remain open.

## Block 4 implementation record — 2026-09-12

The `block-4/member-rsvp` working tree contains the RSVP schemas, migrations, service, HTTP router, admin section, and shared guest form/draft helpers. The frozen route and payload surface is recorded in [the Block 4 contract](./block4Contracts.md). Reviewed test/development migrations, real PostgreSQL tests, independent browser QA, static artifact scanning, and final gates passed on 2026-09-12; [the validation record](./block4Validation.md) contains the evidence and limits.

The operational choices checked before this record are: no deadline is allowed through a paired null value; a configured deadline rejects public writes at `serverNow >= deadlineAt`; a replay of an identical successful request is accepted even after the deadline; a changed payload with the same request ID is rejected; a stale submitted member rolls back the whole submission; omitted members do not conflict; history stores actor and display snapshots; and foreign groups remain administrative-only. The admin UI exposes deadline configuration, current totals/filters, and a separate history view. Any behavior that differs in executed validation must update this record and the contract before acceptance.

## Block 5 contract record — 2026-09-12

This section records the historical Block 5 boundary. Its SMS accounting and provider-readiness decisions were superseded by the PIN-only decision above; messages, mural, deletion, and reports remain current.

The operator approved the Block 5 orchestration playbook and the detailed contract in [the Block 5 contract](./block5Contracts.md). The implementation must keep one revision-protected message per group, runtime-only mural reads, administrator deletion without text editing, message-only group blocking, confirmed transactional group deletion, wedding-scoped CSV/PDF reports, and site-level monthly SMS accounting.

No numeric SMS ceiling is configured by default. New real SMS sends remain blocked until an `OWNER` explicitly configures a limit and every existing provider gate is satisfied. The manually shared group PIN is the expected MVP verification path because real SMS may remain outside the MVP due to infrastructure operating cost. Deterministic simulation may prove quota behavior but is not evidence of Twilio usage, delivery, or cost.

## Block 5 implementation record — 2026-09-12

The `block-5/messages-exports-sms` working tree implements the frozen Block 5 contract across the database, API, admin panel, public feature package, and demo host. The authorized local acceptance passed contract tests, the full isolated PostgreSQL suite, independent desktop/mobile browser QA, downloads and PDF inspection, static artifact privacy scanning, and repository gates. The detailed evidence and limits are recorded in [the Block 5 validation record](./block5Validation.md); the next-block integration boundary is recorded in [the Block 5 handoff](./block5Handoff.md).

The implementation keeps display snapshots stable across later group/member renames, orders the mural by creation rather than edit time, redacts replayable RSVP responses when their group is deleted, and retains site-period SMS accounting after group deletion. CSV formula protection and local Unicode PDF generation are part of the report boundary. No default SMS ceiling, provider delivery, development/production migration, deploy, or legal-retention approval is implied by local acceptance.

## Block 5 post-delivery reconciliation — 2026-09-13

The Block 5 validation and implementation records above remain historically
accurate for their 2026-09-12 execution. A later PRE0 check added a regression
for the OWNER site list without pagination parameters and confirmed the current
endpoint behavior. It also reproduced the valid SITE_ADMIN activation-fragment
browser failure and corrected the admin form to preserve the initial token
through hydration; a fresh browser load now renders the form before removing
the fragment from the address bar.

The development database was subsequently verified read-only with the guarded
identity utility. The configured branch, project, endpoint, database, and role
matched the expected development target; the latest journal entry corresponds
to `0007_windy_sage`, and the Block 5 tables are present. This note does not
claim a production migration or any production access.

## Block 6 implementation record — 2026-09-13

The `block-6/public-wedding-experience` working tree establishes `@entrelacos/template-root/v1` as the only public template export. It provides the reusable layout, standard home preset, individually usable editorial sections, serializable contracts, validators, responsive navigation, progressive motion, and image/video fallback structure. The exact frozen surface is recorded in [the Block 6 contract](./block6Contracts.md).

The template owns structure and presentation behavior only. Every wedding host owns all visible copy and labels, identity, routes, section IDs/order, SEO/canonical/indexing values, navigation, footer, venue/map/fallback values, media, alt text, and local extensions. Fixed wedding, editorial, navigation, SEO, venue, label, or media content inside `template-root` is prohibited. The supported minimum `/v1` theme contract contains exactly `--template-ivory`, `--template-olive`, `--template-ink`, `--template-muted`, and `--template-line`; internal selectors and additional tokens are not public contracts.

`apps/wedding-demo` is the polished default-preset consumer and owns the Marina & Caio content, `noindex, nofollow` metadata, Google Maps configuration, guest/mural placement, monogram, approved fictional image set, hero poster, and silent hero video. `apps/template-fixture` is a private technical consumer with distinct Casa Aurora data/media/SEO, reordered composition, a local section, and an extra `/hospedagem` route. It is not a second product demo or permanent environment. Both consumers build through `/v1` without copying template source or importing another app.

Lenis `1.3.26` is an internal progressive enhancement with `autoRaf: true`, `lerp: 0.095`, `smoothWheel: true`, `syncTouch: false`, `wheelMultiplier: 0.9`, and `anchors: true`. Reduced motion prevents instantiation and destroys/recreates the instance when the preference changes. Native anchors/touch, visible-by-default reveals, normal-flow mobile/reduced-motion story content, keyboard menu closure/focus restore, and RSVP modal focus/scroll isolation remain required fallbacks.

The gallery presents one host-owned media item per Embla carousel index and exposes host-labeled previous/next controls below the media. Its expand action appears on pointer hover or keyboard focus and opens a synchronized full-screen Base UI dialog; media is never a direct file link. The page-load introduction uses host-owned gallery images and the hero poster extracted from the video's first decoded frame. The approved video preloads independently, starts its muted autoplay loop beneath the overlay fade, and receives a browser paint before the header and hero copy begin their own animations. Reduced motion skips the introduction and pauses video playback at frame zero.

Public visitors receive no panel option. The host-composed `AdminRecognition` feature renders a `Painel` header link only after valid server-backed recognition; failed or absent recognition exposes no panel link. The first recognized visit per browser shows a confirmable administrator-mode banner, dismissed in `localStorage` for that site. Guest, RSVP, message, moderation, and authorization rules remain in `wedding-features` and the API.

Implementation-stage package, focused interaction, typecheck, build, browser, independent black-box QA, consolidated repository, independent diff-review, presentation-feedback, and fictional-demo media gates passed as recorded in [the current validation record](./block6Validation.md). The final logo/favicon/monogram, exact generation-model and cost evidence, real-client rights, deployment, merge, and production approval remain pending. See [the media register](./block6MediaRegister.md).

## Block 7 implementation record — 2026-09-16

The `block-7/quality-demo-recovery` worktree adds the versioned `block7-demo-v1` reset, strict OWNER/exact-origin/demo-marker authorization, transaction-scoped serialization, deterministic operational data, sentinel preservation, safe request/reset observability, local CI helper gates, and a disposable-test load runner. The reset preserves site identity/configuration and administrative/authentication rows; it replaces only the demo site's operational rows and never calls a provider. The frozen boundary and evidence limits are recorded in [the Block 7 contract](./block7Contracts.md) and [validation record](./block7Validation.md).

The default observability sink is allowlisted structured JSON on local stdout. Server-generated request IDs are correlation values only. HTTP rate limits are explicitly labeled, and raw request/response/error objects, credentials, visitor identity, phones, PINs/OTPs, messages, cookies, and secrets remain outside the event surface. External sink selection, access, shipping, and retention remain open decisions.

The 20-wedding by 500-guest run is evidence only for its recorded local endpoint mix, concurrency, fixture distribution, and resources; it is not a capacity guarantee. Browser acceptance is partial because no secret-safe SITE_ADMIN or representative/family one-time identity was established. Remote CI, real restoration, RPO/RTO, legal/privacy/retention/media-rights decisions, provider approval, and final go/no-go remain unproven or open. These limits prevent marking B7-T6, B7-T7, or Block 7 complete.

## Superseded historical details

- Historical notes that made the group name optional are superseded. Current rule: group name required.
- Historical discovery material suggesting possible self-service, broader CMS, gifts, checkout, uploads, WhatsApp, or other future capabilities is not current scope.
- Historical notes treating the entire ivory/dark-olive direction, motion setup, or fictional demo photos/video as unapproved are superseded by the local Block 6 baseline and the 2026-09-14 media record. Final brand, logo/favicon/monogram, real-client media rights, and launch approval remain pending.

## Open decisions and release gates

1. Commercial buyer, price, revision policy, cancellation, renewal, tolerance period, and support service levels. These are external business-policy decisions, not technical MVP blockers, but must be addressed for commercial operations.
2. Cloudflare, Railway, Neon, CI, and media-provider account ownership, credentials, permissions, region/country access, and costs.
3. The guest-to-API cross-origin transport is resolved as an exact-origin bearer flow using site-namespaced `sessionStorage`. The authenticated admin panel-to-public-site handoff and recognized-only return link are implemented locally; final independent clean-browser proof remains pending.
4. Privacy notice, retention schedule, data rights, deletion exceptions, client media permissions, and legal review.
5. Neon tier, retention/cost, backup strategy, and real restoration evidence for RPO at most one hour and RTO at most eight hours.
6. The Block 6 ivory/olive editorial presentation and final fictional-demo media are the implemented local baseline. Final logo/favicon/monogram approval, exact provider/model/cost traceability, real-client rights, production performance, and launch approval remain open.
7. Production domain/DNS responsibilities, custom-domain ownership and renewal, and worker-per-wedding scale response.

Open items must be marked pending or blocked in implementation evidence. A mock provider, placeholder media, owner-entered status, or local health response cannot be reported as proof that the corresponding external capability is live.

## Listening

The package-manager migration authorized on 2026-09-09 replaces the earlier package-manager choice with Bun 1.3.14 for all workspaces and CI. Node.js 24, Turborepo, Vitest, dependency version pins, and application boundaries remain unchanged. Isolated installs retain explicit workspace dependency boundaries and package-local CLI paths; a runtime or test-framework migration is outside this change.

Block 3 now selects a persistent six-digit group PIN for provider-free MVP delivery and keeps browser-tab-scoped guest persistence. A random database seed plus a domain-separated server HMAC derives the PIN; plaintext PIN storage and an offline-brute-forceable plain hash were rejected. `localStorage`, cross-site cookies, URL tokens, and a custom refresh-token system remain rejected because the seven-day server record already supplies the absolute lifetime while `sessionStorage` reduces browser persistence and cross-site credential coupling.

The template/site study preserves the reference repository's host/package ownership but expands the public section surface for local customization. Fixed-page-only reuse and a generic page builder were rejected; Block 6 now supplies the two-consumer local build proof, while independent final QA and media acceptance remain pending.

Block 4 keeps RSVP presentation in `packages/wedding-features` while leaving deadline, authorization, concurrency, persistence, and history in the API. A template or site may choose location and styling through the public feature seam, but static output cannot contain family data, sessions, responses, credentials, or operational fixtures. This preserves the Block 6 design boundary and keeps Block 5 reporting/messages from creating a second RSVP authority.

The 2026-09-22 verification flow requires the registered invitation phone and its persistent manual PIN, without a name lookup. SMS quota, simulation, delivery, and provider integration are retired rather than retained as dormant options.
