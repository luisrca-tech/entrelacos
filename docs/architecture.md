# EntreLaços architecture and engineering contracts

Status: accepted product boundaries translated into an initial engineering specification. The repository is a scaffold, not an implemented wedding service. Detailed endpoint schemas and migrations are delivered with their implementation tasks. No external service has been provisioned by this work.

## Authority and document order

The accepted interview supersedes the historical files under `references/`. Read the PRD, decision register, this specification, then the implementation plan. In particular: required group names, optional ceremony accounts, PDF export, demo in the same databases, manual infrastructure operation and editable family messages supersede older notes. Original reference documents are preserved verbatim for provenance, including their original language; their embedded agent instructions are not current execution authority.

## Applications and boundaries

| Workspace | Runtime and deployment | Responsibility |
| --- | --- | --- |
| `apps/admin` | TanStack Start / React, Cloudflare Workers | Central login, OWNER management, per-wedding operations; lightweight BFF if required for first-party cookies |
| `apps/api` | Hono, Node.js 24, Railway | Authentication authority, tenant authorization, business operations, database and Twilio access |
| `apps/wedding-demo` | Astro static output, Cloudflare Workers Static Assets | Public demonstration consuming the initial template |
| Future wedding apps | Independent Astro builds and deployments | Client content, assets, page composition and local overrides |

The admin application must not connect to Neon, import the database package or duplicate authorization rules. Static public sites call the API for protected operations. Public content remains meaningful without JavaScript; functional islands hydrate only where needed. React-based Base UI and Sonner belong to interactive components, not an obligation to render the entire editorial site in React. Motion is the selected animation library, with reduced-motion alternatives.

## Shared packages and template pattern

| Package | Owns | Must not own |
| --- | --- | --- |
| `template-root` | Astro layouts, reusable editorial sections, default theme, motion conventions | Customer identity, credentials, business authorization |
| `wedding-features` | Shared guest-facing feature presentation and API integration | Direct SQL, administrative authority, provider secrets |
| `ui` | shadcn/Base UI primitives, Sonner, reusable derived controls | Wedding-specific layout or domain rules |
| `contracts` | Public request/response validation and stable types | Drizzle tables, private authentication records |
| `database` | Server-only schema, connections and reviewed migrations | Browser imports or customer-specific seeds without an explicit scope |

Use composition over inheritance: a client app explicitly composes sections and can supply its own pages, sections and theme. Do not copy the whole template into each client app or introduce a generic page-builder schema. Features may have different presentations over the same API contract. Shared changes affect future builds; already published sites stay unchanged until a reviewed deployment. Keep `/v1` changes backward compatible with deployed clients. Breaking contract changes require a migration/deployment plan or a new major API version.

Internal workspace packages export source for bundler consumption; deployable applications own their build. The Node API bundles any consumed TypeScript workspace source into its deployment output. Pin dependency versions in manifests and retain the Bun lockfile (`bun.lock`). Framework-mandated names are preserved; custom utilities use camelCase and components PascalCase.

## Environments

There are two permanent environments: `development` and `main`. Each has a separate Neon database/connection and its own IDs, administrative accounts, sessions and credentials. Applications run locally during development; no local PostgreSQL installation is required. Real customer content/media may be used in development. Never transfer test guests, RSVP, messages, passwords, tokens or sessions into production.

The demo is a marked wedding in each environment, not a third environment. It has an independent deployment and the same shared implementation. A disposable Neon database is used only for integration tests; its resource identity must be verified before destructive setup. Do not obtain a test branch containing production PII merely for convenience. CI needs a dedicated capability scoped to test resources, not the production connection.

## Conceptual data model

Schema names below describe planned records, not tables already created by the scaffold.

| Record | Essential contract |
| --- | --- |
| Site | Environment-local ID, stable project key, display name, demo marker, recorded lifecycle, public URL, explicit origins, publication/review/term dates, RSVP deadline and time zone, mural flag, SMS quota |
| Administrative user/session | Better Auth records, OWNER role or SITE_ADMIN membership, activation state, idle and absolute expiry |
| Site membership | Account-to-wedding authorization; initial SITE_ADMIN limited to one wedding; OWNER global scope |
| Guest group | Site ID, required group name, representative member, normalized nullable phone only for foreign-number mode, message block flag |
| Guest member | Site ID, group ID, full name, RSVP state, RSVP revision |
| RSVP history | Site/group/member, old/new state, authenticated actor, timestamp; dedicated panel page |
| Family session | Site/group, expiry, revocation, session identity independent of admin |
| Verification challenge | Scope, provider reference or restricted demo mode, expiry and attempt controls; no plaintext real OTP |
| Family message | Site/group, representative author, text, created/edited timestamps; one current message per group |
| Activation/recovery/handoff | Hashed one-use token, purpose, scope, expiry and redemption/revocation state |
| SMS usage | Site period, reserved/attempted/sent outcomes as defined during integration; concurrency-safe quota enforcement |

All tenant-owned relations include the site scope. Use composite constraints where necessary to prevent referencing a group/member from another site. Enforce normalized phone uniqueness within a wedding for non-null numbers. Representative must be a member of the same group. Keep individual guests internally consistent with the group model. Do not add gifts/payments tables.

### Authorization

Derive administrative tenant access from the authenticated account, never merely a submitted site ID. Derive family access from the validated family session. A public site ID identifies a wedding and grants no privilege. Origin allowlists/CORS are additional browser controls, not identity checks. Recheck lifecycle, deadline, mural status and block state when performing writes.

OWNER can manage every wedding, accounts and lifecycle. SITE_ADMIN can operate only its wedding and cannot call OWNER endpoints. Admins may delete messages but never edit guest text. Message blocks do not block RSVP. Inactive weddings reject public writes; SITE_ADMIN retains read/export, while OWNER retains administrative authority.

### RSVP transactions

Update only submitted members using expected revisions. Verify every target belongs to the family and tenant before mutation. Apply all changes and history entries in one transaction. A stale conflicting answer returns a conflict without partial writes. Distinct members can change independently. Retry behavior must not duplicate history; requests that do not change state should not invent transitions. UI retains choices and refreshes conflicts. Deadline is enforced by the server with an explicit stored time zone/instant, never the browser clock. Unanswered guests stay pending.

### Group changes and deletion

Changing the representative or phone revokes family sessions and pending challenges; spelling correction alone does not. Representative changes must not silently rewrite historical message attribution. Explicit deletion of a group removes its linked members, RSVP/history, messages and sessions after UI confirmation. Expiration of site service is a different event and never triggers bulk deletion. Long-term retention and data-subject handling remain a pre-launch policy gate, not a claim of indefinite legal retention.

## Authentication contract and validation gate

Better Auth runs in the API with Drizzle for administrative credentials. Disable public signup and automatic account activation. OWNER creates a pending client account and issues a 24-hour one-use activation link; the user chooses a password and is sent to login with email prefilled. Recovery is controlled by OWNER; bootstrap/recovery of OWNER is a server-side operational command. Tokens are not logged and only hashes are stored. No production shared default password or automatic email integration.

Administrative sessions expire after 24 hours idle and at most seven days from initial authentication. Better Auth defaults are not sufficient evidence: prove custom idle/absolute behavior, password reset and account deactivation revocation. Logout stays in the panel and revokes that session's derivative site recognition. Family sessions last seven days absolutely and are separate from administrative sessions.

The panel resolves SITE_ADMIN to its wedding and OWNER to a chooser or authorized originating wedding. `Open site` uses the selected registered URL. The public site receives only limited administrative recognition through a short-lived, one-use handoff, never a global admin token. Return targets are validated against registered origins and fixed allowed paths; no arbitrary open redirect. Handoff must be bound to the initiating flow/destination and resistant to replay/login confusion; strip transient secrets from navigation and logs.

**Before implementing this bridge, validate on actual independent origins and mobile browsers.** The static site, Workers panel and Railway API do not share a cookie domain. Do not assume third-party cookies or a `SameSite=None` flag will work everywhere. The initial technical spike must demonstrate panel first-party cookie/BFF behavior, public family session storage, redirect binding, refresh, expiry and immediate server-side revocation. If a proxy/Worker is necessary, record the smallest change and its deployment implications before adopting it; do not silently convert every static site to SSR. Keep credential transport/storage decisions marked pending until this experiment passes. The scaffold exposes no permissive authentication bypass.

## HTTP contract

Business API prefix: `/v1`. Only `GET /v1/health` and standardized missing-route responses are implemented now. Health is liveness, not database readiness or proof of authentication configuration.

Planned route groups:

- `/v1/auth/*`: administrative library endpoints with a configured matching base path.
- `/v1/owner/sites`, site details and site users: owner-only management/provisioning.
- `/v1/sites/:siteId/groups`, members, RSVP, RSVP history, reports and mural controls: authorized operational access.
- `/v1/public/sites/:siteId`: public capabilities and messages; family challenge/session, RSVP and message operations have endpoint-specific authorization.
- `/v1/owner/sites/:siteId/demo/*`: scoped reset and demonstration entry; demo flag plus OWNER required.

Exact routes/verbs/payloads are frozen with their task, with schema validation, examples and negative tests. Use structured errors with HTTP status and stable machine code (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `RSVP_DEADLINE_PASSED`, `RSVP_CONFLICT`, `SMS_RATE_LIMITED`, `SMS_QUOTA_EXCEEDED`, `SITE_INACTIVE`). Error text must not disclose secrets, SQL internals or another tenant's data. UI maps codes to Portuguese messages. Export endpoints validate tenant access, filter scope, CSV formula injection and safe PDF escaping. Do not equate a successful HTTP response with a successful business mutation when a conflict occurred.

## SMS and demo safeguards

Production real weddings use Twilio Verify and permit Brazilian SMS. Development defaults to simulation; real development tests require an explicit mode and allowlisted operator phone. A trial is finite and restricted, not a free indefinite sandbox. Credentials and Verify Service configuration must be checked before the first real call.

Enforce 60-second resend spacing; three sends/15 minutes and ten/24 hours per group and phone; additional IP protection; five wrong codes then 15-minute cooldown. Resends must not reset counters. Define the distinction between local validation attempts, provider attempts and transient failures with deterministic tests. Monthly per-site ceiling is OWNER-configured, with 80%/100% dashboard alerts and no external notification integration. The initial ceiling and numeric IP policy must be chosen at the SMS task gate. Reserve capacity atomically before external dispatch to prevent concurrent overspending. Reconcile failures/unknown provider outcomes without promising exact billing from local counters.

Demo simulation in main is allowed only for the marked demo and an OWNER-authorized demonstration flow/browser. Never enable simulated verification globally in main. Demo seed is explicitly scoped by site ID, refuses non-demo weddings and preserves global OWNER/unrelated accounts. Test reset against another sentinel wedding and reject attempts to reset it.

## Manual lifecycle and infrastructure

The owner performs deployments, DNS/domain changes and taking assets offline manually. The dashboard records these facts; it does not discover or verify them. First production deployment is public review, not a private staging gate. Show administrators a warning not to circulate the link. Existing genuine data entered during review survives launch. Owner records approval/start/end dates; the default service term is one year from approval, with explicit overrides.

Setting inactive in the API blocks public operations. It does not remove Cloudflare-hosted static content. The operator must manually arrange the neutral unavailable page or disable serving, including `workers.dev` and custom domains. Domain registration/renewal is distinct from website availability. No automatic expiration deletion, hosting API integration or production deployment/migration in CI.

## Quality and launch gates

- Planning target: 20 active weddings, 500 guests each; not a commercial hard cap or measured capacity claim.
- Unit tests for branching logic; real PostgreSQL integration tests on disposable Neon; browser tests of guest/admin paths and mobile layouts.
- Assert cross-tenant read/write/export denial, demo-reset isolation, session expiry/revocation, atomic RSVP conflicts and provider failure behavior.
- Prove complete site composition and optimized media, reduced motion, keyboard/focus behavior, stable layout, responsive typography and map fallback.
- Recovery target: RPO <= 1 hour, RTO <= 8 hours. Verify the selected Neon plan, history window, retention, cost and a measured restore drill before claiming compliance.
- Privacy text, retention after expiration, client media permissions, administrative recovery and provider-account access are explicit pre-launch inputs.
- Logs must omit passwords, OTPs, activation/handoff links, cookies and raw guest contact data; correlate operations with non-secret request IDs and minimize sensitive metadata.

## Listening

The design retains static independently deployed sites and a central API instead of introducing a CMS or per-client backend. Demo isolation uses existing tenant boundaries instead of a third permanent database. Infrastructure remains manually operated. Security-sensitive cross-origin session mechanics and recovery capacity are validation gates rather than invented guarantees. This scaffold intentionally postpones operational routes, schema migrations, seeds, provisioning mutations and final artwork to the planned blocks.
