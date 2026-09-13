# EntreLaços Decision Register

**Status:** Durable product decisions from the accepted interview dated 2026-09-09, including the Block 4 and Block 5 implementation decisions recorded on 2026-09-12 and the local Block 6 implementation decisions recorded on 2026-09-13. This register is a concise companion to the PRD; it does not replace the interview record, architecture specification, validation record, or launch approvals.

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
- Drizzle, node-postgres, reviewed/manual SQL migrations, Better Auth, `/v1` JSON contracts, shadcn/Base UI, and Sonner remain current directions. Block 6 uses Lenis plus CSS/Intersection Observer for its approved scrolling and restrained public motion; no Motion dependency was needed for this implementation.
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

At the time of the study, exact section contracts/slots and client indexing intent remained B6 inputs. The Block 6 implementation record below supersedes that planning-state description. Existing final media/provider/rights/cost gates remain open.

## Block 4 implementation record — 2026-09-12

The `block-4/member-rsvp` working tree contains the RSVP schemas, migrations, service, HTTP router, admin section, and shared guest form/draft helpers. The frozen route and payload surface is recorded in [the Block 4 contract](./block4Contracts.md). Reviewed test/development migrations, real PostgreSQL tests, independent browser QA, static artifact scanning, and final gates passed on 2026-09-12; [the validation record](./block4Validation.md) contains the evidence and limits.

The operational choices checked before this record are: no deadline is allowed through a paired null value; a configured deadline rejects public writes at `serverNow >= deadlineAt`; a replay of an identical successful request is accepted even after the deadline; a changed payload with the same request ID is rejected; a stale submitted member rolls back the whole submission; omitted members do not conflict; history stores actor and display snapshots; and foreign groups remain administrative-only. The admin UI exposes deadline configuration, current totals/filters, and a separate history view. Any behavior that differs in executed validation must update this record and the contract before acceptance.

## Block 5 contract record — 2026-09-12

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

`apps/wedding-demo` is the polished default-preset consumer and owns the Marina & Caio content, `noindex, nofollow` metadata, Google Maps configuration, guest/mural placement, monogram, and provisional abstract assets. `apps/template-fixture` is a private technical consumer with distinct Casa Aurora data/media/SEO, reordered composition, a local section, and an extra `/hospedagem` route. It is not a second product demo or permanent environment. Both consumers build through `/v1` without copying template source or importing another app.

Lenis `1.3.26` is an internal progressive enhancement with `autoRaf: true`, `lerp: 0.095`, `smoothWheel: true`, `syncTouch: false`, `wheelMultiplier: 0.9`, and `anchors: true`. Reduced motion prevents instantiation and destroys/recreates the instance when the preference changes. Native anchors/touch, visible-by-default reveals, normal-flow mobile/reduced-motion story content, keyboard menu closure/focus restore, and RSVP modal focus/scroll isolation remain required fallbacks.

The gallery presents one host-owned media item per Embla carousel index and exposes host-labeled previous/next controls below the media. Its expand action appears on pointer hover or keyboard focus and opens a synchronized full-screen Base UI dialog; media is never a direct file link. The page-load introduction is implemented now as a restrained, CSS-only hero reveal independent of the provisional image, so later approved AI image/video work remains a media replacement and tuning step rather than a structural rewrite. Reduced motion disables the entrance.

Public visitors receive no panel option. The host-composed `AdminRecognition` feature renders `Modo administrador` and `Voltar ao painel` only after valid server-backed recognition; failed or absent recognition exposes no panel link. Guest, RSVP, message, moderation, and authorization rules remain in `wedding-features` and the API.

Implementation-stage package, focused interaction, typecheck, build, browser, independent black-box QA, consolidated repository, independent diff-review, and presentation-feedback gates passed as recorded in [the current validation record](./block6Validation.md). Final media acceptance remains pending. The current SVGs are provisional placeholders; no final fictional-couple set, final logo/favicon, AI video, media provider, cost, rights, approval, deployment, merge, or production action is implied. See [the media register](./block6MediaRegister.md).

## Superseded historical details

- Historical notes that made the group name optional are superseded. Current rule: group name required.
- Historical discovery material suggesting possible self-service, broader CMS, gifts, checkout, uploads, WhatsApp, or other future capabilities is not current scope.
- Historical notes treating the entire ivory/dark-olive direction and motion setup as unapproved are superseded by the local Block 6 baseline. Final brand, logo/favicon/monogram, photos/video, media rights, and launch approval remain pending.

## Open decisions and release gates

1. Commercial buyer, price, revision policy, cancellation, renewal, tolerance period, and support service levels. These are external business-policy decisions, not technical MVP blockers, but must be addressed for commercial operations.
2. Cloudflare, Railway, Neon, CI, Twilio, and media-provider account ownership, credentials, permissions, region/country access, and costs.
3. The guest-to-API cross-origin transport is resolved as an exact-origin bearer flow using site-namespaced `sessionStorage`. The authenticated admin panel-to-public-site handoff and recognized-only return link are implemented locally; final independent clean-browser proof remains pending.
4. Privacy notice, retention schedule, data rights, deletion exceptions, client media permissions, and legal review.
5. Neon tier, retention/cost, backup strategy, and real restoration evidence for RPO at most one hour and RTO at most eight hours.
6. The Block 6 ivory/olive editorial presentation is the implemented baseline. Final logo/favicon/monogram approval, fictional-couple image approval, video provider/cost/rights, and image-to-video poster workflow remain open.
7. Production domain/DNS responsibilities, custom-domain ownership and renewal, and worker-per-wedding scale response.

Open items must be marked pending or blocked in implementation evidence. A mock provider, placeholder media, owner-entered status, or local health response cannot be reported as proof that the corresponding external capability is live.

## Listening

The package-manager migration authorized on 2026-09-09 replaces the earlier package-manager choice with Bun 1.3.14 for all workspaces and CI. Node.js 24, Turborepo, Vitest, dependency version pins, and application boundaries remain unchanged. Isolated installs retain explicit workspace dependency boundaries and package-local CLI paths; a runtime or test-framework migration is outside this change.

Block 3 now selects a persistent six-digit group PIN for provider-free MVP delivery and keeps browser-tab-scoped guest persistence. A random database seed plus a domain-separated server HMAC derives the PIN; plaintext PIN storage and an offline-brute-forceable plain hash were rejected. `localStorage`, cross-site cookies, URL tokens, and a custom refresh-token system remain rejected because the seven-day server record already supplies the absolute lifetime while `sessionStorage` reduces browser persistence and cross-site credential coupling.

The template/site study preserves the reference repository's host/package ownership but expands the public section surface for local customization. Fixed-page-only reuse and a generic page builder were rejected; Block 6 now supplies the two-consumer local build proof, while independent final QA and media acceptance remain pending.

Block 4 keeps RSVP presentation in `packages/wedding-features` while leaving deadline, authorization, concurrency, persistence, and history in the API. A template or site may choose location and styling through the public feature seam, but static output cannot contain family data, sessions, responses, credentials, or operational fixtures. This preserves the Block 6 design boundary and keeps Block 5 reporting/messages from creating a second RSVP authority.

Block 5 keeps manual PIN as the operational MVP path and uses a nullable site SMS limit as an explicit closed gate. This avoids inferring provider budget while still requiring quota concurrency and alert behavior to be proven with deterministic simulation before any later real-SMS approval.
