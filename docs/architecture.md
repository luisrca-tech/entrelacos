# EntreLaços architecture and engineering contracts

Status: accepted product boundaries translated into an incremental engineering specification. Blocks 1–3 implement the workspace foundation, administrative authentication/lifecycle, and guest identity slice. Blocks 4 and 5 passed their authorized local database, browser, artifact, and repository validation. The current product keeps messages, runtime mural controls, safe group deletion, RSVP exports, and manual PIN verification; SMS delivery and Twilio integration are retired. Complete production infrastructure acceptance remains later work.

## Authority and document order

The accepted interview supersedes the historical files under `references/`. Read the PRD, decision register, this specification, then the implementation plan. In particular: required group names, optional ceremony accounts, PDF export, demo in the same databases, manual infrastructure operation and editable family messages supersede older notes. Original reference documents are preserved verbatim for provenance, including their original language; their embedded agent instructions are not current execution authority.

## Applications and boundaries

| Workspace | Runtime and deployment | Responsibility |
| --- | --- | --- |
| `apps/admin` | TanStack Start / React, Cloudflare Workers | Central login, OWNER management, per-wedding operations; lightweight BFF if required for first-party cookies |
| `apps/api` | Hono, Node.js 24, Railway | Authentication authority, tenant authorization, business operations, database access, and manual PIN verification |
| `apps/wedding-demo` | Astro static output, Cloudflare Workers Static Assets | Public demonstration consuming the initial template |
| Future wedding apps | Independent Astro builds and deployments | Client content, assets, page composition and local overrides |

The admin application must not connect to Neon, import the database package or duplicate authorization rules. Static public sites call the API for protected operations. Public content remains meaningful without JavaScript; functional islands hydrate only where needed. React-based Base UI and Sonner belong to interactive components, not an obligation to render the entire editorial site in React. Motion is the selected animation library, with reduced-motion alternatives.

## Shared packages and template pattern

| Package | Owns | Must not own |
| --- | --- | --- |
| `template-root` | Astro layouts, reusable editorial sections, default theme, motion conventions | Customer identity, credentials, business authorization |
| `wedding-features` | Shared guest-facing feature presentation, family-session transport, RSVP form, family message editor, runtime mural, and draft/reconciliation helpers | Direct SQL, administrative authority, deadline or moderation enforcement, provider secrets |
| `ui` | shadcn/Base UI primitives, Sonner, reusable derived controls | Wedding-specific layout or domain rules |
| `contracts` | Public request/response validation and stable types | Drizzle tables, private authentication records |
| `database` | Server-only schema, connections and reviewed migrations | Browser imports or customer-specific seeds without an explicit scope |

Use composition over inheritance: a client app explicitly composes sections and can supply its own pages, sections and theme. Do not copy the whole template into each client app or introduce a generic page-builder schema. Features may have different presentations over the same API contract. Shared changes affect future builds; already published sites stay unchanged until a reviewed deployment. Keep `/v1` changes backward compatible with deployed clients. Breaking contract changes require a migration/deployment plan or a new major API version.

Internal workspace packages export source for bundler consumption; deployable applications own their build. The Node API bundles any consumed TypeScript workspace source into its deployment output. Pin dependency versions in manifests and retain the Bun lockfile (`bun.lock`). Framework-mandated names are preserved; custom utilities use camelCase and components PascalCase.

## Planned template/host refinement (2026-09-12)

The [template/site study](../plans/entrelacos-template-site-study.md) refines the composition boundary for Blocks 4–8. These exports and contracts are planned, not current implementation claims.

- Keep `template-root` and `apps/wedding-demo`; add a public presentation `/v1` entrypoint in B6-T0 with a reusable layout, a standard page preset and individually usable editorial sections. Preserve or migrate existing imports explicitly.
- Each host owns serializable public content, media, per-page SEO, routes, environment configuration and custom sections. The shared layout renders metadata from host inputs. Extra pages reuse it without requiring every preset section's data.
- Hosts compose `wedding-features` into template slots or local pages. The template has no API/environment dependency. API contracts, sessions, RSVP deadlines and mural authority remain in their operational blocks; mural data is runtime data, not static content.
- Verify two independently built compositions, one with an extra page and local/reordered section, before treating the template as reusable. Use native Astro composition and narrow documented theme variables rather than inheritance or a page-builder registry.
- Versioned exports express compatibility, while Git/lockfile/build inputs and retained artifacts provide release reproducibility. Publication and rollback remain per site and manual. Nested wedding apps require explicit workspace/CI discovery checks.

## Environments

There are two permanent environments: `development` and `main`. Each has a separate Neon database/connection and its own IDs, administrative accounts, sessions and credentials. Applications run locally during development; no local PostgreSQL installation is required. Real customer content/media may be used in development. Never transfer test guests, RSVP, messages, passwords, tokens or sessions into production.

The demo is a marked wedding in each environment, not a third environment. It has an independent deployment and the same shared implementation. A disposable Neon database is used only for integration tests; its resource identity must be verified before destructive setup. Do not obtain a test branch containing production PII merely for convenience. CI needs a dedicated capability scoped to test resources, not the production connection.

## Conceptual data model

Schema names below describe the current product model. Site, administrative identity, site membership, guest group/member, family session, and manual PIN challenge records form the identity boundary. Block 4 adds validated member RSVP state/revision, paired site deadline, history snapshots, and site-scoped request receipts. Block 5 adds durable message revisions and request receipts plus deletion-safe RSVP receipt links. Historical SMS accounting records are retired by the PIN-only migration.

| Record | Essential contract |
| --- | --- |
| Site | Environment-local ID, stable project key, display name, demo marker, recorded lifecycle, public URL, explicit origins, publication/review/term dates, RSVP deadline and time zone, mural flag |
| Administrative user/session | Better Auth records, OWNER role or SITE_ADMIN membership, activation state, idle and absolute expiry |
| Site membership | Account-to-wedding authorization; initial SITE_ADMIN limited to one wedding; OWNER global scope |
| Guest group | Site ID, required group name, representative member, normalized nullable phone only for foreign-number mode, message block flag |
| Guest member | Site ID, group ID, full name, RSVP state, RSVP revision |
| RSVP history | Site/group/member, old/new state, actor type/ID/display snapshot, timestamp; dedicated panel view with filters and cursor pagination |
| RSVP request receipt | Site/group/actor scope, request ID and hash, response body/status; unique idempotency key for replay-safe writes |
| Family session | Site/group, expiry, revocation, session identity independent of admin |
| Verification challenge | Site/group/phone scope, expiry, wrong-attempt and cooldown controls for the manual group PIN; the PIN itself is derived and never stored in plaintext |
| Family message | Site/group, representative and group display snapshots, normalized plain text, created/edited timestamps; one current message per group plus durable revision and idempotency receipt |
| Activation/recovery/handoff | Hashed one-use token, purpose, scope, expiry and redemption/revocation state |

All tenant-owned relations include the site scope. Use composite constraints where necessary to prevent referencing a group/member from another site. Enforce normalized phone uniqueness within a wedding for non-null numbers. Representative must be a member of the same group. Keep individual guests internally consistent with the group model. Do not add gifts/payments tables.

### Authorization

Derive administrative tenant access from the authenticated account, never merely a submitted site ID. Derive family access from the validated family session, including its site and group. A public site ID, route ID, member ID, administrative recognition, or demo grant identifies context at most and grants no privilege. Origin allowlists/CORS are additional browser controls, not identity checks. Recheck lifecycle and deadline when performing RSVP writes.

OWNER can manage every wedding, accounts and lifecycle. SITE_ADMIN can operate only its wedding and cannot call OWNER endpoints. Admins may delete messages but never edit guest text. Message blocks do not block RSVP. Inactive weddings reject public writes; SITE_ADMIN retains read/export, while OWNER retains administrative authority.

### RSVP transactions

Update only submitted members using expected revisions. Verify every target belongs to the exact family group and tenant before mutation. Apply all state changes, revision increments, transition history, and the idempotency receipt in one transaction. A stale submitted member returns `RSVP_CONFLICT` without partial writes; details include current state/revision for conflicting members. Distinct members can change independently. Identical retries return the stored response, including after a lost response and after the public deadline; a changed payload under the same request ID returns `IDEMPOTENCY_KEY_REUSED`. No-op writes return `NO_CHANGE` and do not create history. The UI retains choices and refreshes conflicts. Deadline is enforced by the server at `serverNow >= deadlineAt`, with an explicit UTC instant and IANA timezone; it is never delegated to the browser clock. Unanswered guests stay pending.

### Group changes and deletion

Changing the representative or phone revokes family sessions and pending challenges; spelling correction alone does not. Representative changes must not silently rewrite historical message attribution. Explicit deletion of a group removes its linked members, RSVP/history, messages and sessions after UI confirmation. Expiration of site service is a different event and never triggers bulk deletion. Long-term retention and data-subject handling remain a pre-launch policy gate, not a claim of indefinite legal retention.

## Authentication contract and validation gate

Better Auth runs in the API with Drizzle for administrative credentials. Disable public signup and automatic account activation. OWNER creates a pending client account and issues a 24-hour one-use activation link; the user chooses a password and is sent to login with email prefilled. Recovery is controlled by OWNER; bootstrap/recovery of OWNER is a server-side operational command. Tokens are not logged and only hashes are stored. No production shared default password or automatic email integration.

Administrative sessions expire after 24 hours idle and at most seven days from initial authentication. Better Auth defaults are not sufficient evidence: prove custom idle/absolute behavior, password reset and account deactivation revocation. Logout stays in the panel and revokes that session's derivative site recognition. Family sessions last seven days absolutely and are separate from administrative sessions.

The panel resolves SITE_ADMIN to its wedding and OWNER to a chooser or authorized originating wedding. `Open site` uses the selected registered URL. The public site receives only limited administrative recognition through a short-lived, one-use handoff, never a global admin token. Return targets are validated against registered origins and fixed allowed paths; no arbitrary open redirect. Handoff must be bound to the initiating flow/destination and resistant to replay/login confusion; strip transient secrets from navigation and logs.

The static site, Workers panel and Railway API do not share a cookie domain. Block 3 therefore uses exact-origin CORS plus a family bearer held only in site-namespaced `sessionStorage`; refresh within the same browser tab restores the session, while leave and server-side revocation invalidate it. Public guest requests do not use credentialed cross-site cookies. The separate panel-to-public administrative handoff still requires independent-origin and mobile validation. If a proxy/Worker is necessary for that later bridge, record the smallest change and its deployment implications before adopting it; do not silently convert every static site to SSR.

## HTTP contract

Business API prefix: `/v1`. Health, administrative authentication/lifecycle, guest-group administration, public PIN challenge/verification, and family-session read/leave routes form the identity slice; Block 4 adds RSVP and Block 5 adds messages, mural administration, reports, and safe deletion. Health remains liveness, not database or business readiness.

Current and planned route groups:

- `/v1/auth/*`: administrative library endpoints with a configured matching base path.
- `/v1/owner/sites`, site details and site users: owner-only management/provisioning.
- `/v1/sites/:siteId/groups`: OWNER/SITE_ADMIN group and member administration, including transient access-PIN reveal, rotation, message blocking, and confirmed transactional deletion.
- `/v1/public/sites/:siteId/guest/challenge` and challenge verification: exact-origin lookup requires full name plus the registered phone; the six-digit manual group PIN is the only confirmation mechanism. There is no resend operation.
- `/v1/public/family/session`: implemented bearer-bound family read and explicit leave.
- `/v1/public/family/rsvp`: Block 4 family read/write using the existing bearer and exact registered origin; read remains available after the deadline while new writes are rejected at the server boundary.
- `/v1/sites/:siteId/rsvp`: Block 4 admin current read/write with group/status filters, active-site post-deadline correction, and exact admin-session/site scope.
- `/v1/sites/:siteId/rsvp/deadline`: Block 4 admin read/PATCH for the paired nullable deadline instant/timezone.
- `/v1/sites/:siteId/rsvp/history`: Block 4 admin filtered cursor-paginated operational history, separate from current RSVP data.
- `/v1/public/family/message` and `/v1/public/sites/:siteId/mural`: Block 5 family message lifecycle and privacy-limited runtime mural read.
- `/v1/sites/:siteId/messages`, `/v1/sites/:siteId/mural`, and group message-block routes: Block 5 site-scoped moderation without administrator text editing.
- `/v1/sites/:siteId/reports/rsvp.csv` and `.pdf`: Block 5 consistent-snapshot downloads with explicit phone and optional group/state filters.

Exact routes/verbs/payloads are frozen with their task, with schema validation, examples and negative tests. Use structured errors with HTTP status and stable machine codes such as `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `RSVP_DEADLINE_PASSED`, `RSVP_CONFLICT`, `INVALID_CODE`, and `SITE_INACTIVE`. Error text must not disclose secrets, SQL internals or another tenant's data. UI maps codes to Portuguese messages. Export endpoints validate tenant access, filter scope, CSV formula injection and safe PDF escaping. Do not equate a successful HTTP response with a successful business mutation when a conflict occurred.

## Manual PIN safeguards

The bride or planner copies the group PIN from authenticated administration and shares it with the public link using an external communication channel. Full name plus the registered phone locates the invitation; both remain required even though no SMS is sent. The PIN is derived from a random group seed and a server HMAC secret, never stored in plaintext, and remains valid until rotation. Rotation revokes existing group sessions and pending challenges.

Manual verification enforces 10 IP attempts/15 minutes, 10 exact site/IP lookups/15 minutes, and five wrong PINs followed by a 15-minute cooldown. Challenges last 10 minutes and have no resend. The marked demo uses the same PIN-only flow. Demo reset remains scoped by site ID, refuses non-demo weddings, preserves global OWNER/unrelated accounts, and must be tested against a sentinel wedding.

## Manual lifecycle and infrastructure

The owner performs deployments, DNS/domain changes and taking assets offline manually. The dashboard records these facts; it does not discover or verify them. First production deployment is public review, not a private staging gate. Show administrators a warning not to circulate the link. Existing genuine data entered during review survives launch. Owner records approval/start/end dates; the default service term is one year from approval, with explicit overrides.

Setting inactive in the API blocks public operations. It does not remove Cloudflare-hosted static content. The operator must manually arrange the neutral unavailable page or disable serving, including `workers.dev` and custom domains. Domain registration/renewal is distinct from website availability. No automatic expiration deletion, hosting API integration or production deployment/migration in CI.

## Quality and launch gates

- Planning target: 20 active weddings, 500 guests each; not a commercial hard cap or measured capacity claim.
- Unit tests for branching logic; real PostgreSQL integration tests on disposable Neon; browser tests of guest/admin paths and mobile layouts.
- Assert cross-tenant read/write/export denial, demo-reset isolation, session expiry/revocation, atomic RSVP conflicts, and invalid-PIN behavior.
- Prove complete site composition and optimized media, reduced motion, keyboard/focus behavior, stable layout, responsive typography and map fallback.
- Recovery target: RPO <= 1 hour, RTO <= 8 hours. Verify the selected Neon plan, history window, retention, cost and a measured restore drill before claiming compliance.
- Privacy text, retention after expiration, client media permissions, administrative recovery and provider-account access are explicit pre-launch inputs.
- Logs must omit passwords, PINs, activation/handoff links, cookies and raw guest contact data; correlate operations with non-secret request IDs and minimize sensitive metadata.
- Block 4 passed the isolated migration, real PostgreSQL transaction/concurrency, cross-wedding fixture, independent desktop/mobile browser QA, static artifact privacy scan, and full local gates recorded in `docs/block4Validation.md`.

## Listening

The design retains static independently deployed sites and a central API instead of introducing a CMS or per-client backend. Demo isolation uses existing tenant boundaries instead of a third permanent database. Family sessions use explicit bearer transport rather than cross-site cookies, while the administrative handoff remains a separate unresolved boundary. Infrastructure remains manually operated. Recovery capacity, later operational routes, deterministic demo reset, provisioning mutations, and final artwork remain planned or gated rather than inferred from local success.

The 2026-09-12 refinement exposes reusable sections alongside a page preset, keeping host-owned extensions possible without copying shared markup. It preserves the existing package structure and operational contracts; a second design system or generic page engine remains deferred.

Block 4 extends the existing family-session boundary rather than creating RSVP identity. The API evaluates the deadline and owns transactional revisions/history; the shared feature package owns draft and presentation behavior. A single request receipt is checked before the public deadline so a lost successful response can be replayed safely, while a new post-deadline write is blocked. This ordering and the member-scoped conflict check preserve both retry safety and independent edits.
