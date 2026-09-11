# Plan: EntreLaços Managed Wedding Websites

> **Status: DRAFT — pending user granularity review.** This plan is derived from [the EntreLaços PRD](./entrelacos-prd.md), the accepted interview dated 2026-09-09, and [the decision register](../docs/decisionRegister.md).

These eight larger blocks define the intended implementation map. Block 1 is complete at the approved scaffold boundary; Blocks 2–8 remain draft product and operations work and require granularity review before scheduling. A block may be split or merged after that review. The plan is an implementation map, not implementation approval for the remaining blocks.

## Delivery status

- **Documentation:** PRD and this draft plan are the documentation deliverables.
- **Scaffold:** Block 1 is complete at the approved runnable-boundary scope. Bun 1.3.14 and Node.js 24.20.0 passed frozen installation, lint on 52 files, seven forced typecheck tasks, four deterministic API tests and three forced application builds; raw HTTP and clean-browser evidence also passed. See `docs/scaffoldValidation.md` for evidence and limits.
- **Product:** Blocks 2–8 are neither approved nor implemented. No provider, secret, deployment, media, or production claim is implied by a mock, placeholder, or passing local health check.

## Durable architectural decisions

These decisions apply across the blocks and remain subject to the explicit gates called out below.

- **Public sites:** one static Astro application and independent public deployment per wedding on Cloudflare Workers Static Assets. No SSR is required for the initial public experience.
- **Admin panel:** one central TanStack Start application on Cloudflare Workers, with global owner management separated from per-wedding operational areas.
- **API authority:** one Hono Node.js/TypeScript API on Railway owns business rules, authentication, authorization, tenant isolation, and database access.
- **API routes:** versioned HTTP JSON contract under `/v1`, with standardized errors and shared contracts separate from database models. Exact endpoint names are an architecture-specification decision.
- **Database:** shared PostgreSQL on Neon, with every business operation scoped by stable wedding/site identity. Development, main, and disposable integration resources are separate. The public frontend never accesses Neon.
- **Core data model:** wedding/site lifecycle and configuration; `OWNER`; wedding-bound `SITE_ADMIN`; family/group; member; representative and normalized phone; guest challenges and sessions; member RSVP and history; one group message and moderation state; domain/origin and publication status; SMS usage and limits.
- **Authentication:** Better Auth with Drizzle persistence for admins; independent family-scoped guest sessions after provider-backed OTP. The selected cross-origin session/handoff design remains a required spike.
- **Data access and migrations:** Drizzle with node-postgres and reviewed/manual SQL migrations. Main-environment migrations are explicit manual operations.
- **UI and motion:** shadcn with Base UI, Sonner for shared feedback, and Motion for the approved intro, text, and story choreography. CSS/Intersection Observer remain appropriate for simple interactions and entrances.
- **Template model:** composition over inheritance. A reusable template supplies sections, layout, and defaults; each wedding composes its own pages and approved content. Shared changes affect newly built sites only. Template and public-site copy is always Brazilian Portuguese (`pt-BR`), never `en-US`.
- **External services:** Twilio Verify is the opt-in real SMS boundary; tests default to deterministic mocks. Cloudflare, Railway, Neon, CI resources, and any media provider require real account access and explicit credentials. No provider guarantee is assumed.
- **Operational control:** production deployment, domains, DNS, lifecycle status, main migrations, and provider setup are manual and recorded as owner-entered status. No silent mass publication or automatic expiry deletion exists.

## Cross-cutting rules for every block

- Use English for persisted documentation, code, comments, and implementation artifacts; use deterministic fixtures for tests.
- Templates and public wedding sites are always Brazilian Portuguese (`pt-BR`). Do not author template defaults, site copy, or guest-facing site UI in `en-US`. Site and template fixtures follow the same locale.
- Apply TDD to logic-bearing behavior: write the focused failing test first, then implement the smallest complete vertical slice.
- Keep mock integrations visibly distinct from real provider results. A mocked Twilio flow proves application behavior only.
- Verify authorization in the API and prove cross-tenant isolation with a second wedding and sentinel data.
- Treat guest data, sessions, passwords, secrets, and production code as separate concerns during reset, reuse, deletion, and deployment.
- Add browser evidence for protected or interactive behavior in a clean browser, including mobile and reduced-motion states where relevant.
- Record unresolved legal, retention, recovery, media, authentication, and provider assumptions as gates; do not convert them into guarantees through wording.

---

## Block 1: Approved scaffold and environment health

**Track:** Scaffold foundation. Completing this block establishes runnable boundaries; it does not implement guest, RSVP, message, lifecycle, or visual product behavior.

**Completion status:** Complete for the approved local scaffold boundary on 2026-09-10. The evidence covers the frozen Bun install, static checks, compiled API liveness, admin navigation and the static demo. Product behavior remains deferred to later blocks.

**User stories:** US-001–US-003, US-020–US-022, US-117–US-118.

**Dependencies:** None for a local skeleton beyond the confirmed stack and repository access. Later integration requires the explicit resources listed in the preflight.

### BEFORE START

- **Infrastructure:** None for local scaffold. Do not create Cloudflare, Railway, Neon, Twilio, CI, or media resources as part of this block.
- **Tools:** Node 24, Bun workspaces, Turborepo, TypeScript, the selected lint/test/build tools, and browser tooling must be available to the implementer. Install the pinned workspace dependencies as part of scaffold setup; no live provider connection is required.
- **Secrets and access:** None. Use examples and placeholders only; never place Neon, Railway, Better Auth, Twilio, Cloudflare, CI, or media secrets in the repository.
- **Decisions:** Package/application boundaries, `/v1` contract boundary, server-only database access, environment naming, and liveness semantics must be recorded in the architecture specification before implementation starts.

### Concrete vertical-slice tasks

1. **B1-T1 — Establish workspace boundaries.** Establish the approved workspace boundaries for the public demo site, central panel, API, template foundation, shared guest behavior, UI primitives, contracts, and database concerns.
2. **B1-T2 — Add liveness paths.** Give each runnable surface a minimal liveness response. Liveness must not claim database, SMS, media, or other provider readiness.
3. **B1-T3 — Define configuration gates.** Record environment examples and the future validation boundary that distinguishes public configuration from server secrets. Do not implement provider readiness or required-secret checks in the liveness scaffold.
4. **B1-T4 — Establish test/build entry points.** Establish a shared contract/test path with deterministic fixtures and a CI command shape for type checks, lint, tests, and builds. Keep integration tests gated on an explicit disposable database URL.
5. **B1-T5 — Record deferred gates.** Document scaffold status and deferred product gates so a green skeleton cannot be interpreted as a working wedding product.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B1-T1 | **Infrastructure:** none. **Tools:** Node 24, Bun, Turborepo. **Secrets/access:** repository access only. **Decisions:** approved app/package boundaries. | None |
| B1-T2 | **Infrastructure:** none. **Tools:** local runtimes and browser smoke tool. **Secrets/access:** none. **Decisions:** liveness response semantics; no dependency readiness claim. | B1-T1 |
| B1-T3 | **Infrastructure:** none. **Tools:** documentation/config review. **Secrets/access:** none; examples only. **Decisions:** public-versus-server configuration boundary. | B1-T1 |
| B1-T4 | **Infrastructure:** CI runner may be local-only initially. **Tools:** type/lint/test/build tools. **Secrets/access:** no live credentials; disposable Neon URL remains a future gate. **Decisions:** deterministic fixture and CI gate shape. | B1-T1 |
| B1-T5 | **Infrastructure:** none. **Tools:** documentation review. **Secrets/access:** none. **Decisions:** product gates named in PRD and register. | B1-T1–B1-T4 |

### What to deliver

- A runnable monorepo scaffold with the agreed application and package boundaries.
- Honest liveness behavior for local development that makes no provider-readiness claim.
- Documented configuration boundaries and examples with no real credentials.
- Initial test/build/lint/type-check entry points and documentation navigation.
- A clear handoff that all product behavior remains unimplemented.

### Tests and acceptance evidence

- `bun run lint`, `bun run typecheck --force`, `bun run test` and `bun run build --force` pass with the pinned Bun and Node versions; the forced Turbo runs report zero cached tasks.
- Liveness responses identify the running surface and do not report database, SMS, or media readiness.
- Provider readiness and required-secret validation are recorded as later integration gates; no current scaffold test is presented as proof of them.
- The disposable Neon integration gate is documented as pending and is not replaced by an in-memory imitation. No live database, authentication, SMS, cross-origin, recovery or finished visual acceptance was exercised.
- Evidence names the exact scaffold commands and confirms no production mutation, external provider setup, commit, push or deployment occurred during this completion run.

---

## Block 2: Tenant/site lifecycle and administrative access

**Track:** Product. This block creates the operator-to-wedding operational path and controlled admin access; public visual customization remains in Block 6.

**User stories:** US-001–US-002, US-018–US-040, US-107–US-110, US-119–US-120.

**Dependencies:** Block 1; reviewed admin data model and contracts; disposable Neon integration; cross-origin authentication spike before protected browser acceptance.

### BEFORE START

- **Infrastructure:** A Neon development database and disposable integration base must exist with approved access. Railway, Cloudflare, and production domains are not required for local implementation, but their eventual ownership must be named.
- **Tools:** Better Auth, Drizzle, node-postgres, migration/test tooling, clean-browser tooling, and manual activation/recovery test procedures must be available.
- **Secrets and access:** Development database URL, server session/auth secret, and controlled owner bootstrap access are required for integration. Keep all server values out of public bundles. Do not invent or share production credentials.
- **Decisions:** Role permissions, 24-hour activation, 24-hour idle/7-day absolute admin sessions, logout invalidation, lifecycle states, one-year term start, origin records, and the cross-origin cookie/BFF/time-bound handoff choice must be explicitly recorded. The cross-origin choice is not considered solved by a local same-origin test.

### Concrete vertical-slice tasks

1. **B2-T1 — Create or resume a site.** Create and resume a draft wedding through an authenticated internal API operation, using stable site identity and idempotent behavior without direct script-to-database writes.
2. **B2-T2 — Activate the first administrator.** Create the first site administrator with a hashed, one-use, 24-hour activation token; manually consume it to set a password, then require explicit login.
3. **B2-T3 — Recover access.** Add controlled recovery and owner-only bootstrap paths. Verify token revocation, reuse failure, expiry, and no public signup.
4. **B2-T4 — Enforce panel tenancy.** Deliver panel entry for an owner chooser and a site-admin direct wedding view. The owner can read global and cross-wedding operational data; a site administrator can read only the assigned wedding's operational data plus site status and term. Prove that a site administrator cannot discover or query a second wedding.
5. **B2-T5 — Exercise sessions and handoff.** Deliver logout, idle expiration, absolute expiration, and invalidation of derived site recognition. Exercise the selected authenticated cross-origin handoff in a clean browser.
6. **B2-T6 — Record site lifecycle.** Record owner-managed status, public URL, origins, domain state, dates, review approval, term, deactivation, reactivation, and neutral inactive-site state. Preserve data on deactivation.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B2-T1 | **Infrastructure:** Neon development and disposable integration database. **Tools:** API contract and migration test tools. **Secrets/access:** development database URL and server secret. **Decisions:** stable site identity and authenticated internal operation. | B1-T1, B1-T4 |
| B2-T2 | **Infrastructure:** same Neon resources. **Tools:** Better Auth and token test support. **Secrets/access:** controlled owner bootstrap access; no email provider. **Decisions:** one-use hashed token and 24-hour expiry. | B2-T1 |
| B2-T3 | **Infrastructure:** same Neon resources. **Tools:** restricted command/test procedure. **Secrets/access:** owner-only bootstrap/recovery access. **Decisions:** no public signup and manual delivery. | B2-T2 |
| B2-T4 | **Infrastructure:** Neon integration base. **Tools:** panel browser test tool. **Secrets/access:** owner and site-admin fixtures. **Decisions:** owner chooser versus site-admin direct entry and site binding. | B2-T2 |
| B2-T5 | **Infrastructure:** browser-test environment with API and panel origins. **Tools:** clean-browser automation. **Secrets/access:** session secret and configured test origins. **Decisions:** cross-origin cookie/BFF/time-bound handoff must be selected or remain a gate. | B2-T4 |
| B2-T6 | **Infrastructure:** Neon integration base. **Tools:** lifecycle transition tests. **Secrets/access:** owner fixture. **Decisions:** one-year term, manual status, neutral placeholder, data preservation. | B2-T1, B2-T4 |

### What to deliver

- A real tenant/site lifecycle path from draft to recorded review and inactive status.
- Controlled owner and site-admin activation, login, logout, and recovery behavior.
- Tenant-scoped panel navigation and authorization.
- Explicit lifecycle records for URL, origins, domains, dates, term, and manual status.
- A documented cross-origin authentication spike result or a blocking gate when evidence is incomplete.

### Tests and acceptance evidence

- Disposable Neon integration tests cover idempotent create/resume, hashed one-use tokens, expiry, revocation, role boundaries, lifecycle transitions, and data preservation.
- Clean-browser evidence covers activation, explicit login, logout, idle/absolute expiry, owner chooser, site-admin direct entry, public “Panel” navigation, and selected cross-origin behavior.
- A two-wedding isolation test demonstrates that a site administrator cannot read or mutate the other wedding by changing route or request identifiers.
- Inactive-site evidence shows read-only admin/export intent and a neutral public state without deleting operational data.
- No automatic email, provider monitoring, domain mutation, or production deployment is claimed.

---

## Block 3: Guest groups, OTP verification, sessions, and abuse controls

**Track:** Product. This block establishes the family-scoped guest identity used by RSVP and messages.

**User stories:** US-041–US-065, US-102–US-103.

**Dependencies:** Blocks 1–2; guest data and contract design; disposable Neon base; provider boundary; cross-origin result where guest requests span origins.

### BEFORE START

- **Infrastructure:** Disposable Neon integration resources are required. Real Twilio Verify is optional for application development and is only eligible after account/country/usage checks.
- **Tools:** Deterministic SMS mock, rate-limit test utilities, clean-browser tooling, and the selected Twilio Verify adapter boundary are required. A mock is not a provider guarantee.
- **Secrets and access:** Mock mode needs no live secrets. A real test requires Twilio Account SID, Auth Token, Verify Service SID, permitted destination phone(s), country/geo permissions, trial/usage confirmation, and explicit owner authorization. Never expose these in frontend configuration.
- **Decisions:** Required group name, minimum one member, one representative, normalized Brazilian phone uniqueness per wedding, foreign-number behavior, name normalization/rejection rules, session lifetime, resend/attempt/cooldown limits, and demo authorization are fixed by the PRD.

### Concrete vertical-slice tasks

1. **B3-T1 — Manage groups and members.** Deliver admin creation, editing, representative selection, deletion, and validation for named groups, one or more members, individual invitations, and one wedding-scoped phone.
2. **B3-T2 — Locate a group safely.** Implement deterministic lookup normalization for case, accents, and extra spaces while rejecting approximate, abbreviated, or incomplete names. Add the foreign-number path and its persistent explanation.
3. **B3-T3 — Enforce OTP protection.** Implement the OTP challenge contract with mocked delivery by default. Enforce a 60-second resend wait, three total sends (including the initial send) per 15 minutes, ten total sends per 24 hours, wedding/group and phone scopes, IP throttles, five failed attempts, and 15-minute cooldown without resetting counters on resend.
4. **B3-T4 — Create and revoke guest sessions.** Create family-bound guest sessions with seven-day absolute expiry and an explicit leave action. Revoke sessions and pending challenges after representative/phone changes; preserve them for spelling-only corrections.
5. **B3-T5 — Isolate demo simulation.** Add owner-authorized, demo-marked simulation behavior that cannot become a general bypass. Label simulated outcomes separately from provider responses.
6. **B3-T6 — Verify opt-in live SMS.** Run the live Twilio path only as an explicit gated verification after permissions are confirmed; preserve mock-default tests if live delivery is unavailable.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B3-T1 | **Infrastructure:** Neon disposable base. **Tools:** contract/migration tests. **Secrets/access:** site-admin fixture and development DB URL. **Decisions:** required group name, representative, phone scope, individual invitation model. | B2-T1, B2-T4 |
| B3-T2 | **Infrastructure:** none beyond B3-T1 data. **Tools:** normalization and browser tests. **Secrets/access:** guest fixture data. **Decisions:** exact normalization and strict rejection rules; foreign-number behavior. | B3-T1 |
| B3-T3 | **Infrastructure:** none for mock mode. **Tools:** deterministic SMS mock and rate-limit clock. **Secrets/access:** no live secrets. **Decisions:** 60-second resend wait, three total sends per 15 minutes, ten total sends per 24 hours, attempt, cooldown, wedding/group/phone/IP scopes. | B3-T2 |
| B3-T4 | **Infrastructure:** Neon disposable base. **Tools:** session/expiry test clock. **Secrets/access:** guest session secret. **Decisions:** seven-day absolute lifetime and revocation triggers. | B3-T3 |
| B3-T5 | **Infrastructure:** isolated demo-marked tenant and sentinel tenant. **Tools:** deterministic simulation fixture. **Secrets/access:** owner-authorized demo browser/phone allowlist. **Decisions:** simulation label and no general bypass. | B3-T4 |
| B3-T6 | **Infrastructure:** Twilio Verify account/trial or paid usage access. **Tools:** live provider adapter and clean-browser test. **Secrets/access:** SID, Auth Token, Verify Service SID, permitted phone, country/geo access. **Decisions:** explicit owner opt-in and evidence standard; otherwise remain mock/pending. | B3-T3, B3-T4 |

### What to deliver

- A wedding-scoped guest group and member management path.
- Safe lookup, foreign-number handling, OTP challenge, family session, revocation, and abuse controls.
- Mock-default provider boundary plus an honest opt-in Twilio verification path.
- Owner-authorized demo simulation isolated from real tenants.

### Tests and acceptance evidence

- TDD covers validation, uniqueness, lookup normalization, foreign-number rules, session boundaries, revocation, and every rate-limit counter edge.
- Disposable Neon tests prove no cross-tenant group lookup, member mutation, session use, or phone uniqueness leakage.
- Clean-browser mobile/desktop evidence shows the lookup, code entry, resend timer, error/cooldown states, session leave, and persistent foreign-number explanation.
- A real Twilio test is reported only if the account, destination, country, trial, and usage permissions are confirmed. Otherwise evidence states that provider validation remains pending; mock success is never presented as live delivery.

---

## Block 4: RSVP, deadlines, concurrency, and operational history

**Track:** Product. This block turns verified family access into reliable member-level attendance operations.

**User stories:** US-066–US-082.

**Dependencies:** Blocks 1–3; member-level RSVP model; explicit timezone handling; disposable Neon integration; clean-browser guest identity.

### BEFORE START

- **Infrastructure:** Disposable Neon integration database with repeatable fixtures. No new production infrastructure is required.
- **Tools:** Browser test runner, timezone-aware test clock, deterministic fixtures, and database transaction/concurrency test support.
- **Secrets and access:** None beyond Block 2/3 development credentials. No SMS send is needed to test saved RSVP after a guest session fixture exists.
- **Decisions:** Three states (`PENDING`, `CONFIRMED`, `DECLINED`), explicit save, confirm-all draft shortcut, partial pending, deadline datetime plus timezone, post-deadline admin correction, no automatic pending decline, member-level versioning, all-or-nothing conflict handling, and separate history view are fixed.

### Concrete vertical-slice tasks

1. **B4-T1 — Answer family RSVP.** Deliver a guest RSVP view listing every family member, with pending/confirmed/declined state, confirm-all draft, partial responses, explicit save, and clear feedback.
2. **B4-T2 — Adapt RSVP presentation.** Deliver desktop modal and mobile full-screen RSVP presentations with the same API behavior and immediate error/success response.
3. **B4-T3 — Enforce deadline.** Add deadline configuration and enforcement with explicit timezone. Guests can read after the deadline but cannot save changes; admins can correct externally received responses.
4. **B4-T4 — Protect concurrent updates.** Add member-level optimistic concurrency. A stale all-or-nothing submission reports a conflict while retaining selections; unrelated members remain independently editable.
5. **B4-T5 — Record operational history.** Deliver a separate operational history view with before/after values, actor, timestamp, group, and member filters. Keep daily current-state operations readable.
6. **B4-T6 — Preserve pending state.** Preserve pending states through deadline and export preparation; never infer decline from silence.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B4-T1 | **Infrastructure:** Neon disposable base. **Tools:** guest browser flow and deterministic member fixtures. **Secrets/access:** valid family session fixture. **Decisions:** three states, representative authority, explicit save, partial pending. | B3-T4 |
| B4-T2 | **Infrastructure:** none beyond public/admin test surfaces. **Tools:** clean-browser viewport checks. **Secrets/access:** guest session fixture. **Decisions:** desktop modal/mobile full-screen behavior. | B4-T1 |
| B4-T3 | **Infrastructure:** Neon disposable base. **Tools:** timezone-aware test clock. **Secrets/access:** site-admin fixture. **Decisions:** deadline timezone, guest read-only state, admin correction. | B4-T1 |
| B4-T4 | **Infrastructure:** Neon transaction/concurrency support. **Tools:** concurrent request test harness. **Secrets/access:** two valid family/session fixtures. **Decisions:** member-level versioning and all-or-nothing conflict response. | B4-T1 |
| B4-T5 | **Infrastructure:** Neon disposable base. **Tools:** history/filter tests. **Secrets/access:** owner/site-admin actor fixtures. **Decisions:** audit fields and separate operational view. | B4-T3, B4-T4 |
| B4-T6 | **Infrastructure:** none beyond RSVP persistence. **Tools:** regression tests. **Secrets/access:** none. **Decisions:** no automatic pending decline. | B4-T1, B4-T3 |

### What to deliver

- Guest family RSVP from lookup through saved member responses.
- Deadline lock and admin correction behavior with timezone clarity.
- Concurrency conflict handling that avoids stale overwrites.
- Operational history distinct from current RSVP data.

### Tests and acceptance evidence

- Database tests cover full, partial, repeated, post-deadline, admin-corrected, and concurrent member updates with rollback on conflict.
- Browser evidence covers mobile full-screen, desktop modal, draft shortcut, explicit save, deadline read-only state, and conflict recovery.
- A two-wedding fixture proves RSVP reads and writes remain family and tenant bound.
- History evidence names actor, time, before/after, group, and member while excluding unrelated tenant data.

---

## Block 5: Messages, mural moderation, exports, and SMS usage controls

**Track:** Product. This block completes the operational data surface and reporting path.

**User stories:** US-083–US-103.

**Dependencies:** Blocks 1–4; guest session and representative identity; admin roles; disposable Neon integration; PDF/CSV generation approach; numeric SMS ceiling decision before final acceptance.

### BEFORE START

- **Infrastructure:** Disposable Neon integration resources. No message or report provider is needed. A Twilio usage account is needed only if live usage accounting is verified.
- **Tools:** Deterministic message fixtures, CSV/PDF generation and pagination tools, browser print/PDF evidence, and usage-counter test support.
- **Secrets and access:** None for mocked message/export tests. A live SMS ceiling test requires Twilio usage access and the owner-approved service configuration; do not invent provider usage data.
- **Decisions:** One message per group, 1,000-character limit with emojis/newlines, no HTML/attachments, representative-only edit, admin-only delete, group block independent from RSVP, per-site mural toggle retaining data, public author privacy, deletion cascade, report fields/filters, and numeric monthly send ceiling remain required.

### Concrete vertical-slice tasks

1. **B5-T1 — Publish and edit a group message.** Deliver representative message create/edit with server-derived group identity, 1,000-character validation, newline/emoji support, and immediate feedback.
2. **B5-T2 — Render and disable the mural.** Deliver public mural rendering that exposes author name and group only, never phone, member list, or RSVP. Add mural on/off behavior retaining stored data and blocking writes while disabled.
3. **B5-T3 — Moderate messages.** Deliver admin delete and group message block/unblock. Verify deletion permits later publication and blocking never prevents RSVP.
4. **B5-T4 — Delete a group safely.** Deliver confirmed group deletion with explicit confirmation and cascade of members, RSVP, messages, sessions, and pending challenges. Preserve unrelated tenant and sentinel data.
5. **B5-T5 — Export wedding reports.** Deliver wedding-scoped CSV and paginated printable PDF reports with heading, generated date/time, totals, groups, member names/statuses, representative phone inclusion/omission, and RSVP filters. Exclude messages.
6. **B5-T6 — Enforce SMS usage ceiling.** Deliver owner-configured monthly SMS ceiling, usage display, 80%/100% alerts, and blocked-new-send guidance while keeping saved RSVP, existing sessions, and admin RSVP available. Keep the default numeric value pending until decided.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B5-T1 | **Infrastructure:** Neon disposable base. **Tools:** message validation/browser tests. **Secrets/access:** verified representative session. **Decisions:** one message, 1,000-character limit, allowed text content. | B3-T4 |
| B5-T2 | **Infrastructure:** public-site test surface. **Tools:** clean-browser privacy checks. **Secrets/access:** no additional secrets. **Decisions:** mural toggle retains data and blocks writes. | B5-T1 |
| B5-T3 | **Infrastructure:** Neon disposable base. **Tools:** admin/browser moderation tests. **Secrets/access:** site-admin and owner fixtures. **Decisions:** admin delete only; group block independent from RSVP. | B5-T1, B5-T2 |
| B5-T4 | **Infrastructure:** Neon disposable base with sentinel tenant. **Tools:** transaction/cascade tests. **Secrets/access:** site-admin/owner fixture. **Decisions:** explicit confirmation and deletion cascade; retention policy gate remains open. | B4-T5, B5-T3 |
| B5-T5 | **Infrastructure:** Neon disposable base. **Tools:** CSV/PDF generation and print/browser evidence. **Secrets/access:** authorized admin fixture. **Decisions:** report fields, filters, pagination, messages excluded. | B4-T5, B5-T4 |
| B5-T6 | **Infrastructure:** usage store and optional Twilio account data. **Tools:** counter/alert test clock. **Secrets/access:** owner fixture; live usage access only if provider-approved. **Decisions:** numeric default and blocked-send policy. | B3-T3, B5-T1 |

### What to deliver

- Verified representative message lifecycle and public mural controls.
- Admin moderation and destructive group deletion with safe confirmation.
- Wedding-scoped CSV/PDF reporting.
- Transparent SMS usage and ceiling behavior.

### Tests and acceptance evidence

- TDD covers limits, emojis/newlines, identity derivation, blocked groups, mural disablement, deletion cascade, report filters, and send-ceiling boundary values.
- Browser evidence proves public privacy, message edit/delete/re-publish, mural disabled state, admin moderation, exports, PDF pagination, and blocked-send guidance.
- Database isolation tests prove deletion and exports cannot touch or include a second wedding; a sentinel tenant remains unchanged.
- PDF/CSV fixtures prove messages are omitted and selected phone/RSVP fields are included exactly as requested.
- Usage evidence distinguishes mocked counters from real Twilio account usage and makes no delivery or budget guarantee without provider verification.

---

## Block 6: Public wedding experience, template composition, media, and responsive access

**Track:** Product and client-facing visual work. The public template is developed independently from operational authorization but must expose the real RSVP/message boundaries from Blocks 3–5. All template and public-site copy is `pt-BR`, not `en-US`.

**User stories:** US-004–US-019, US-038–US-039, US-121–US-122.

**Dependencies:** Block 1 public-site scaffold; approved provisional-to-final visual direction; content fixtures; selected motion approach; media approval gate; maps/location data; guest actions from Blocks 3–5.

### BEFORE START

- **Infrastructure:** Local/public-site development only. A real Cloudflare deployment is not required until Block 8. No permanent demo environment/database may be created.
- **Tools:** Astro, responsive browser tooling, accessibility checks, Motion for the approved intro/text/story choreography, and image/video optimization tooling.
- **Secrets and access:** None for fixture-based visual work. A media provider key, Cloudflare credentials, or production URL is not needed until their respective gates. Never put server secrets in the static site.
- **Decisions:** Final visual direction, logo/favicon, hero treatment, media rights, fictional-couple approval, video provider/cost, image-to-video poster workflow, map provider constraints, and motion tokens must be explicitly approved before final client-facing acceptance. The current ivory/dark-olive serif direction remains provisional.

### Concrete vertical-slice tasks

1. **B6-T1 — Compose the hero.** Compose an image-led hero with names, date, location, approved photo or muted loop video, poster, responsive crop, immediate fallback, and restrained entrance motion.
2. **B6-T2 — Compose the story.** Compose alternating editorial story sections and one desktop sticky narrative sequence that becomes normal vertical flow on mobile and reduced motion.
3. **B6-T3 — Add practical sections.** Add compact gallery, schedule, ceremony/reception, guidance, map/embed or direction link, copy-address fallback, RSVP entry, mural entry, and responsive footer.
4. **B6-T4 — Add navigation and extensibility.** Add transparent-to-solid navigation, public page extensibility, and authorized “Panel” entry without turning public pages into a login bypass.
5. **B6-T5 — Apply interaction accessibility.** Ensure practical UI remains direct, readable, keyboard/focus accessible, and immediately responsive. Keep one expressive character-text statement at most; use simpler reveals elsewhere.
6. **B6-T6 — Approve media treatment.** Run visual content and media acceptance with an approved fictional couple set where needed. If image generation or image-to-video tooling is unavailable, use an approved image fallback and record the media gate as pending.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B6-T1 | **Infrastructure:** local public-site runtime. **Tools:** Astro, responsive browser checks, Motion for approved intro/text choreography. **Secrets/access:** approved fixture assets only. **Decisions:** hero media, crop, poster, fallback, visual direction. | B1-T2 |
| B6-T2 | **Infrastructure:** local public-site runtime. **Tools:** Motion for approved story/text sequence; reduced-motion browser setting. **Secrets/access:** approved story fixtures. **Decisions:** one sticky desktop sequence and mobile/reduced-motion fallback. | B6-T1 |
| B6-T3 | **Infrastructure:** map/link test fixtures. **Tools:** responsive/accessibility/browser checks. **Secrets/access:** approved venue data; no map secret required for link fallback. **Decisions:** practical section order and venue representation. | B6-T1 |
| B6-T4 | **Infrastructure:** public and panel test origins. **Tools:** navigation/browser checks. **Secrets/access:** authorized admin fixture only for panel entry. **Decisions:** page extensibility and no public login bypass. | B2-T4, B6-T3 |
| B6-T5 | **Infrastructure:** none beyond public-site runtime. **Tools:** keyboard, reduced-motion, and layout-shift checks. **Secrets/access:** none. **Decisions:** immediate practical feedback and motion accessibility rules. | B6-T2, B6-T3 |
| B6-T6 | **Infrastructure:** approved media provider only if selected. **Tools:** image/video optimization and any approved image/video generation tool. **Secrets/access:** media keys/rights/approvals if provider use is approved. **Decisions:** fictional couple, rights, costs, provider, poster workflow. | B6-T1, B6-T2 |

### What to deliver

- A complete public wedding story with practical information and guest action entry points.
- Responsive, reduced-motion, accessible variants of the approved template direction.
- Media fallback and poster behavior that do not depend on autoplay or sound.
- A documented visual/media approval record, including rights, cost, provider, and credential status.

### Tests and acceptance evidence

- Clean-browser evidence at agreed mobile, tablet, and desktop viewports covers hero, navigation theme transition, gallery controls, sticky story fallback, practical sections, map fallback, footer, RSVP entry, and mural entry.
- Accessibility evidence covers reading order, keyboard focus, reduced motion, no forced scroll, no content loss, and no layout shift from late media.
- Media evidence names approved assets and permissions. A mocked or placeholder video is never reported as an approved provider workflow.
- Public-site tests prove no static bundle contains Neon, Railway, Better Auth, Twilio, or other server credentials.

---

## Block 7: Demo, quality gates, abuse, observability, and recovery readiness

**Track:** Cross-cutting product readiness. This block proves the slices together and establishes honest operational evidence before production.

**User stories:** US-065, US-101–US-103, US-114–US-118, US-123–US-124.

**Dependencies:** Blocks 1–6; representative end-to-end fixtures; CI access; disposable Neon resources; chosen logging/metrics boundary; explicit legal/retention and RPO/RTO decisions.

### BEFORE START

- **Infrastructure:** Disposable Neon base and CI test resources are required for database integration. Production recovery resources are not assumed until Neon tier/retention/cost are selected.
- **Tools:** Clean-browser automation, load/burst tooling, database isolation fixtures, CI runner, structured logging/metrics, and a restoration exercise procedure.
- **Secrets and access:** CI requires an explicit disposable Neon test URL and test-only server secrets. Real Twilio credentials require the same gated permissions as Block 3. Recovery evidence requires authorized Neon backup/restore access. No production secret belongs in test logs.
- **Decisions:** Demo site identity/allowlist, sentinel tenant, target load (20 active weddings and 500 guests each), alert and log retention, RPO ≤1 hour/RTO ≤8 hours claims, privacy/retention schedule, legal rights/media permissions, and go/no-go criteria must be settled or marked blocked.

### Concrete vertical-slice tasks

1. **B7-T1 — Seed and reset the demo.** Build deterministic demo data covering pending, partial, confirmed, declined, messages, disabled mural, rate-limit states, inactive site, and representative changes. Add an owner-only manual reset limited to the demo site and prove sentinel preservation.
2. **B7-T2 — Run end-to-end browser QA.** Exercise end-to-end owner, site-admin, representative, RSVP, message, export, deadline, inactive-site, and public navigation flows in a clean browser.
3. **B7-T3 — Measure target load.** Run burst/load tests against the target planning scale and record latency, failures, rate limits, and tenant isolation. Treat results as evidence for observed capacity, not a guarantee beyond the tested shape.
4. **B7-T4 — Gate CI.** Add CI gates for types, lint, tests, builds, and disposable-database integration when credentials/resources exist. Keep main migration and production deploy manual.
5. **B7-T5 — Add safe observability.** Add structured operational logging, usage/error signals, and alerts without logging passwords, OTPs, phones beyond policy, or secret values. Make simulated provider outcomes distinguishable from live outcomes.
6. **B7-T6 — Prove recovery.** Perform a real backup/restore exercise and calculate observed RPO/RTO. If Neon tier, retention, cost, legal retention, or restoration proof is incomplete, keep the corresponding launch gate open.
7. **B7-T7 — Review legal and rights gates.** Review privacy, data rights, retention, deletion, client media permission, and support procedures with the responsible human/legal owner. Record unresolved items instead of inferring compliance.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B7-T1 | **Infrastructure:** isolated demo and sentinel tenants in disposable Neon. **Tools:** deterministic seed/reset runner. **Secrets/access:** owner-authorized demo browser/phone allowlist. **Decisions:** demo marker, reset scope, simulation labels. | B3-T5, B5-T4, B6-T4 |
| B7-T2 | **Infrastructure:** integrated local/test API, panel, and public site. **Tools:** clean-browser automation. **Secrets/access:** test owner/site-admin/guest fixtures. **Decisions:** end-to-end acceptance matrix. | B4-T2, B5-T5, B6-T5 |
| B7-T3 | **Infrastructure:** disposable load environment and database. **Tools:** burst/load/isolation runner. **Secrets/access:** test-only DB/API credentials. **Decisions:** 20 active weddings × 500 guests planning target and evidence limits. | B7-T1, B7-T2 |
| B7-T4 | **Infrastructure:** CI runner and disposable Neon resource. **Tools:** type/lint/test/build tooling. **Secrets/access:** explicit CI test URL and test secrets only. **Decisions:** no main migration/deploy automation. | B1-T4, B7-T2 |
| B7-T5 | **Infrastructure:** approved log/metrics sink or local structured output. **Tools:** redaction and alert tests. **Secrets/access:** observability access without production secret exposure. **Decisions:** retention and sensitive-field policy; simulated/live labels. | B3-T3, B5-T6 |
| B7-T6 | **Infrastructure:** chosen Neon tier/retention and authorized backup/restore access. **Tools:** restoration procedure and timestamp measurement. **Secrets/access:** backup credentials. **Decisions:** RPO ≤1h/RTO ≤8h claim and cost acceptance. | B7-T3 |
| B7-T7 | **Infrastructure:** none. **Tools:** legal/privacy/media review process. **Secrets/access:** responsible owner/legal and media-rights reviewers. **Decisions:** retention, rights, deletion, permissions, support, and launch outcome. | B5-T4, B6-T6, B7-T5 |

### What to deliver

- Isolated, repeatable demo fixtures and owner-only reset behavior.
- End-to-end quality evidence across public, admin, guest, RSVP, message, export, and lifecycle paths.
- Capacity, abuse, observability, CI, and recovery evidence with explicit limits.
- Launch-gate register for legal/retention, media rights, provider access, authentication, and RPO/RTO.

### Tests and acceptance evidence

- Demo reset changes only demo site data; a sentinel wedding, owner, and unrelated tenant remain unchanged.
- Clean-browser end-to-end run passes with both mocked provider and explicitly labelled provider-unavailable states.
- Burst/load/isolation reports identify test shape and observed results; no hard capacity guarantee is made.
- CI evidence shows disposable Neon integration is gated by explicit credentials and cannot target main.
- Restore evidence includes measured timestamps and cost/tier assumptions. RPO/RTO remain “unproven” until real restoration passes.
- Legal/retention/media review outputs include owner and decision date; unresolved items block the relevant release claim.

---

## Block 8: Provisioning, independent deployment, domains, and manual lifecycle operations

**Track:** Production operations. This block turns approved slices into repeatable managed delivery while preserving manual provider boundaries.

**User stories:** US-018, US-031–US-037, US-104–US-113, US-118.

**Dependencies:** Blocks 1–7; architecture specification; cross-origin authentication proof; production Cloudflare/Railway/Neon access; domain/DNS ownership; Twilio/media decisions where used; legal/retention and recovery gates for launch.

### BEFORE START

- **Infrastructure:** Cloudflare account and per-site Worker configuration, Railway API environment, Neon development/main projects, CI integration base, and any approved media provider must be manually provisioned and documented. No permanent third demo environment/database is allowed.
- **Tools:** Deployment CLI/dashboard access, repository provisioning skill mechanism, idempotence/dry-run tests, migration review process, DNS tooling, rollback procedure, and clean-browser production smoke checks.
- **Secrets and access:** Cloudflare deploy credentials, Railway secrets, Neon development/main URLs, Better Auth secret, approved origin/public URLs, Twilio SID/Auth token/Verify Service SID and geo allowlist if real SMS is enabled, CI test URL, and media provider keys if approved. Values must be held in server/provider secret stores and never bundled into public sites.
- **Decisions:** Production approval owner, domain/DNS responsibilities, renewal policy, launch warning, rollback state, inactive placeholder, retention/deletion after term, custom-domain policy, and whether every unresolved gate blocks launch must be explicit.

### Concrete vertical-slice tasks

1. **B8-T1 — Plan and implement provisioning script plus repository skill.** The task must prepare a local wedding app, request API draft site/first account through an authenticated internal operation, default to development, support explicit configuration reuse, resume safely, and avoid duplicates/overwrites. This task is planned here and is not implemented as part of writing this plan.
2. **B8-T2 — Prove provisioning safety.** Verify provisioning dry-run, retry, interruption, resume, and idempotence against a disposable environment. Prove it does not write passwords, secrets, or direct database records.
3. **B8-T3 — Deploy one reviewed wedding.** Deploy one reviewed wedding independently to Cloudflare Workers Static Assets and the API to Railway through manual operator steps. Record public URL, origin, status, dates, and deployment evidence without claiming automatic monitoring.
4. **B8-T4 — Protect first production data.** Exercise the first production path with clean operational data, allow real guest entry during review, and prove launch does not wipe guests, RSVP, sessions, or passwords. Preserve a verified rollback backup before mutation.
5. **B8-T5 — Configure origins and domains.** Configure and smoke-test explicit per-wedding browser origins/CORS, domain/DNS records, panel/site navigation, and the selected cross-origin auth behavior. Keep custom-domain registration and renewal as separate manual responsibilities.
6. **B8-T6 — Operate deactivation and reactivation.** Deliver manual deactivation, neutral placeholder, read-only consultation/export, reactivation, and data-preservation operations. Keep expiration deletion and renewal automation out of scope.
7. **B8-T7 — Run go/no-go review.** Run final go/no-go review for cloud access, Twilio/media permissions, legal/retention, recovery proof, visual approval, target quality evidence, and operator support readiness. Block claims where evidence is missing.

### Task-level preflight

| Task | Must have before start | Depends on |
| --- | --- | --- |
| B8-T1 | **Infrastructure:** API draft operation and local site scaffold. **Tools:** provisioning skill mechanism, dry-run/resume tooling. **Secrets/access:** development API credential; no direct DB credential in script. **Decisions:** development default, explicit reuse, no overwrite/duplicates. | B2-T1, B6-T4 |
| B8-T2 | **Infrastructure:** disposable Neon and disposable public-site/API target. **Tools:** interruption/idempotence test harness. **Secrets/access:** test-only API/database access. **Decisions:** resume and failure semantics. | B8-T1 |
| B8-T3 | **Infrastructure:** Cloudflare account/Worker and Railway service manually provisioned. **Tools:** deployment CLI/dashboard and build artifact checks. **Secrets/access:** Cloudflare deploy credential, Railway secrets, Neon main URL, Better Auth secret. **Decisions:** manual deployment and owner-entered status. | B6-T6, B7-T2, B7-T4 |
| B8-T4 | **Infrastructure:** main database and verified rollback backup. **Tools:** migration review and clean-browser smoke checks. **Secrets/access:** production access approved for named operator only. **Decisions:** clean operational data, review-entry period, no launch reset. | B8-T3, B7-T6, B7-T7 |
| B8-T5 | **Infrastructure:** per-wedding public/panel/API origins and domain/DNS access. **Tools:** DNS/browser smoke checks. **Secrets/access:** explicit browser-origin/CORS configuration and deployment credentials. **Decisions:** cross-origin auth proof, custom-domain ownership/renewal. | B2-T5, B8-T3 |
| B8-T6 | **Infrastructure:** deployed public site/API/panel. **Tools:** lifecycle browser and export checks. **Secrets/access:** owner/site-admin fixtures. **Decisions:** neutral placeholder, read-only access, data preservation, no automatic deletion. | B2-T6, B5-T5, B8-T3 |
| B8-T7 | **Infrastructure:** all required production accounts and rollback/recovery resources. **Tools:** release checklist and evidence review. **Secrets/access:** Cloudflare/Railway/Neon/Twilio/CI/media access individually verified. **Decisions:** legal, retention, recovery, media, visual, support, and launch approval gates. | B7-T6, B7-T7, B8-T4, B8-T5, B8-T6 |

### What to deliver

- A reviewed provisioning script/repository-skill implementation task with idempotent/resumable acceptance criteria.
- One independently deployable wedding path with manual Cloudflare/Railway/Neon/domain operations.
- Explicit origin, status, term, deployment, rollback, and inactive-site records.
- Final launch checklist that distinguishes verified integration from pending provider/legal/recovery/media decisions.

### Tests and acceptance evidence

- Provisioning tests prove dry-run, retry, resume, idempotence, development default, explicit reuse, no duplicate tenants, no password overwrite, and no direct database bypass.
- Deployment evidence includes reviewed build output, public URL, API health, database migration review, manual DNS/origin confirmation, and clean-browser public/admin/guest smoke checks.
- A rollback backup is verified before production mutation; restoration evidence is preserved according to the recovery gate.
- Deactivation/reactivation evidence proves public neutral state, admin read-only behavior, export availability, and retained data.
- Final report names Cloudflare, Railway, Neon, Twilio, CI, and media access status individually. Missing credentials or provider permissions remain pending and do not become fake guarantees.

---

## Proposed granularity review

The eight blocks are intentionally larger than individual tickets but each contains complete vertical-slice tasks and its own preflight, deliverables, and evidence. Granularity review should address:

1. Does this eight-block granularity fit the intended implementation cadence, or should any block be split or merged?
2. Should the public visual/media block run in parallel with RSVP/messages after the scaffold, or remain sequenced behind the operational slices?
3. Should provisioning/deployment remain one final operations block, or should provisioning be separated from first production launch?

Until that review is answered, this plan remains **DRAFT**.

## Listening

The plan records Block 1 as complete because its approved scaffold boundary has executable and browser evidence. It keeps the minimal scaffold conclusion instead of rebuilding the skeleton or treating placeholders as product behavior. Blocks 2–8 remain deferred and require their own approval, implementation and integration evidence.
