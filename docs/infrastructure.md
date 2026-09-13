# Infrastructure and credentials preflight

No real provider resource was created, configured or mutated by the scaffold. Do not paste secrets into project documentation or chat. Store them in ignored local environment files or provider secret stores, and use environment-specific credentials. The implementation plan adds task-specific preflight to this common register.

## Resource register

| Resource | Required before | Inputs and access | Verification |
| --- | --- | --- | --- |
| Node / Bun | Scaffold | Node 24; Bun pinned by packageManager; registry access | Frozen install and all local checks |
| Neon development | Persistence/admin block | Dedicated PostgreSQL URL; selected project/branch/database; TLS configuration | Apply reviewed migrations and test connection without printing URL |
| Neon main | Production preparation | Separate production URL with controlled access | Explicitly verify destination, migration plan and rollback/recovery procedure |
| Neon disposable test resource | Database acceptance / CI | Test-only URL and explicit test resource identity; temporary provisioning permissions if automated | Reject development/main targets; sentinel isolation tests; cleanup restricted to disposable resource |
| Better Auth | Admin authentication | Server-only high-entropy secret; admin/API origins and auth base URL; controlled owner bootstrap capability | Activation/recovery, token hash storage, 24h idle/7d absolute expiry, revocation and no public signup |
| Cross-origin browser topology | Authentication spike | Distinct panel/API/site origins, local equivalents initially and eventual provider URLs | Actual independent-origin/mobile tests; first-party cookies/BFF and narrow site handoff decisions recorded |
| Cloudflare | Manual publication | Account ownership, approved worker names, deploy capability, admin compatibility settings, static assets config | Manual deploy, public URL, HTTPS, fallback/static routing; no fabricated account ID |
| Railway | API publication | Project/service access, root build context, PORT, server environment variables | API liveness; later authenticated readiness/integration evidence separately |
| Twilio Verify | First real SMS | Account SID, Auth Token or supported server credential, Verify Service SID, enabled Brazilian destinations, trial restrictions/balance, allowlisted test phone | Controlled real delivery and verification; never treat trial as unlimited/free sandbox |
| SMS policies | Abuse/usage task | Owner-selected monthly per-site ceiling, existing IP limits, `America/Sao_Paulo` accounting periods, provider failure accounting | Concurrent requests cannot exceed reservations; alerts and block behavior verified; no default budget inferred |
| Domain / DNS | Optional custom domain task | Client domain ownership/access, domain provider account, DNS control, renewal responsibility | Verify correct deployment target and TLS; domain renewal remains external |
| Repository CI | CI publication | GitHub repository if selected later, runner access, read-only default workflow permissions | Frozen install/check; no main migration/deploy jobs; add test-only secrets with database suite |
| AI imagery | Media production task | Approved fictional couple reference, prompts, approved generation tool and usage terms | Consistent characters, approved crop/poster, no claim that generated photos depict the real venue |
| AI video | Hero media task | Provider/tool selection, access/key if needed, cost ceiling, input rights and export formats | Short muted loop, matching poster, mobile/reduced-motion fallback and performance checks |
| Recovery | Launch readiness | Neon plan/history limits, retention configuration, backup/restore permissions and operator availability | Measured restore drill against RPO<=1h/RTO<=8h targets; document any gap |
| Privacy and service policy | Launch readiness | Responsible contact, disclosure text, retention and deletion policy, client media authorization, third-party embeds review | Explicit owner review; no automatic claim of legal compliance |

## Environment variables

Names below reflect the runtime through Block 5. Messages, reports, and quota accounting add no secret or provider dependency. PDF generation uses the pinned local PDFKit and DejaVu font packages and contacts no rendering service. Empty examples are not functioning connections, and every secret remains server-only.

API URL examples use the origin `http://localhost:8080`; `/v1` belongs to the HTTP route path. The panel remains on `http://localhost:3000`, and the public demo remains on `http://localhost:4321`. The example `PUBLIC_SITE_ID=demo-wedding` is fictitious and does not identify a provisioned tenant.

Database integration tests use `DATABASE_URL_TEST` exclusively and verify the actual Neon project, branch, endpoint, database, and role before proceeding. Never fall back to `DATABASE_URL`. Store the expected identities in private `DATABASE_PROJECT_ID`, `DATABASE_DEVELOPMENT_BRANCH_ID`, `DATABASE_TEST_BRANCH_ID`, and `DATABASE_NAME` configuration. Different hostnames alone do not prove branch isolation. Block 2 validation status is recorded in `docs/block2Validation.md`; Block 4 and Block 5 execution status is recorded in their respective validation documents.

| Variable | Consumer | Classification |
| --- | --- | --- |
| `PORT` | Node API | Server runtime port |
| `APP_ENV` | Planned API configuration | Environment selector; does not grant permission to main |
| `DATABASE_URL` | API / manually selected migration process | Secret; never frontend |
| `DATABASE_URL_TEST` | Test API / integration tests / test migrations | Secret; isolated disposable database only, with no development fallback |
| `BETTER_AUTH_SECRET` | API | Secret; separate per environment |
| `BETTER_AUTH_URL` | API | Auth endpoint base URL; align configured route prefix |
| `ADMIN_ORIGIN` | API | Explicit trusted admin origin |
| `SMS_MODE` | API | `manual` MVP default; `simulated` for explicit demo/testing; `real` only behind Twilio gates |
| `GUEST_FINGERPRINT_SECRET` | API | Secret HMAC key for phone/IP fingerprints and domain-separated group PIN derivation |
| `EXPOSE_SIMULATION_CODE` | API | Development-only opt-in; disclosure still requires a valid demo grant |
| `TRUST_PROXY_HEADERS` | API | Explicit opt-in for trusted deployment proxies before accepting forwarded client IP headers |
| `GUEST_DEMO_GRANT_SECRET` | API | Secret HMAC key for five-minute owner-issued demo grants |
| `DEMO_PHONE_ALLOWLIST` | API | Private normalized Brazilian phone allowlist for demo grant issuance |
| `TWILIO_ACCOUNT_SID` | API | Server provider identifier |
| `TWILIO_AUTH_TOKEN` | API | Secret |
| `TWILIO_VERIFY_SERVICE_SID` | API | Server Verify service identifier |
| `TWILIO_TEST_PHONE_ALLOWLIST` | API | Private operator test phone list |
| `SMS_REAL_AUTHORIZED` | API | Explicit operator authorization gate for real SMS mode |
| `TWILIO_BRAZIL_CONFIRMED` | API | Explicit confirmation that Brazilian Verify destinations are enabled |
| `TWILIO_TRIAL_USAGE_CONFIRMED` | API | Explicit confirmation that account/trial destination and usage constraints were reviewed |
| `PUBLIC_API_URL` / `PUBLIC_SITE_ID` | Astro build | Public API origin and environment-local wedding identifier; never authorization |
| `VITE_API_URL` / `API_BASE_URL` | Admin BFF/runtime | Endpoint address only; never a credential |

Do not copy development secrets or database rows to main. A stable repository wedding key maps to separate environment-local IDs. Public URLs and environment IDs may be versioned when appropriate; tokens, passwords and PII are not fixture configuration.

## Manual launch checklist

1. Prepare the main wedding record through the authorized API workflow; do not import development guests or sessions.
2. Review and execute production migrations separately from deployments.
3. Build and publish the site/panel/API manually with the correct public configuration and server secrets.
4. Register exact URLs/origins and owner-entered status in the central panel when that feature exists.
5. Issue the bride's activation link. Production review is public; remind admins not to circulate the link yet.
6. Preserve genuine data entered during review. Record approval and the service term after acceptance.
7. For later deactivation, update API state and separately change hosting to an unavailable page or stop serving all public addresses, including workers.dev. Preserve data and keep operational read/export access.

## Open engineering inputs

The Block 3 IP policy is implemented as 10 sends/15 minutes, 30 sends/24 hours, 10 verification attempts/15 minutes, and 10 exact lookups/15 minutes. Block 5 has no numeric monthly SMS ceiling by default: new real SMS sends remain blocked until an `OWNER` explicitly configures a limit and the provider gates pass. Manual PIN is the expected MVP verification path; deterministic simulation may validate quota accounting without proving provider delivery or account usage. Block 4 uses no new environment variable: it requires only verified `DATABASE_URL_TEST` for isolated migration/tests and existing API/admin/family-session configuration. Apply generated migrations to the test database first; apply to development only after separate review; never connect to production. Select the video tool during media preflight. Verify provider plan/limits and recovery costs then, not from an old pricing snapshot. The guest browser transport is an `Authorization` bearer held only in site-namespaced `sessionStorage`; the separate admin-to-public handoff remains a later cross-origin decision.

## Listening

Block 3 keeps `DATABASE_URL` as the development connection and `DATABASE_URL_TEST` as the only integration-test connection. Real Twilio mode uses multiple independent acknowledgement gates so merely adding credentials cannot send an SMS. Forwarded IP headers are ignored unless the deployment explicitly declares a trusted proxy boundary.

Block 4 keeps persistence in the existing Neon topology. RSVP writes, revision checks, history entries, and idempotency receipts are one transactional unit; concurrency and tenant isolation require real PostgreSQL evidence against the disposable test resource. The admin deadline input stores an explicit UTC instant plus IANA timezone. No SMS, personal phone, or provider credential is needed to validate an authenticated RSVP.
