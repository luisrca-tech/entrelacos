# Infrastructure and credentials preflight

No real provider resource was created, configured or mutated by the scaffold. Do not paste secrets into project documentation or chat. Store them in ignored local environment files or provider secret stores, and use environment-specific credentials. The implementation plan adds task-specific preflight to this common register.

## Resource register

| Resource | Required before | Inputs and access | Verification |
| --- | --- | --- | --- |
| Node / Bun | Scaffold | Node 24; Bun pinned by packageManager; registry access | Frozen install and all local checks |
| Neon development | Persistence/admin block | Dedicated PostgreSQL URL; selected project/branch/database; TLS configuration | Apply reviewed migrations and test connection without printing URL |
| Neon main | Production preparation | Separate production URL with controlled access | Explicitly verify destination, migration plan and rollback/recovery procedure |
| Disposable PostgreSQL | Database acceptance / CI | Local Docker Compose or GitHub Actions service | Verify the test database and apply reviewed migrations before the suite |
| Better Auth | Admin authentication | Server-only high-entropy secret; admin/API origins and auth base URL; controlled owner bootstrap capability | Activation/recovery, token hash storage, 24h idle/7d absolute expiry, revocation and no public signup |
| Cross-origin browser topology | Authentication spike | Distinct panel/API/site origins, local equivalents initially and eventual provider URLs | Actual independent-origin/mobile tests; first-party cookies/BFF and narrow site handoff decisions recorded |
| Cloudflare | Manual publication | Account ownership, approved worker names, deploy capability, admin compatibility settings, static assets config | Manual deploy, public URL, HTTPS, fallback/static routing; no fabricated account ID |
| Railway | API publication | Project/service access, root build context, PORT, server environment variables | API liveness; later authenticated readiness/integration evidence separately |
| Domain / DNS | Optional custom domain task | Client domain ownership/access, domain provider account, DNS control, renewal responsibility | Verify correct deployment target and TLS; domain renewal remains external |
| Repository CI/CD | GitHub validation and deployment migrations | Runner access, read-only workflow permissions, environment-scoped Neon credentials for CD | Validate with disposable PostgreSQL, then migrate the environment selected by the deployment branch |
| AI imagery | Media production task | Approved fictional couple reference, prompts, approved generation tool and usage terms | Consistent characters, approved crop/poster, no claim that generated photos depict the real venue |
| AI video | Hero media task | Provider/tool selection, access/key if needed, cost ceiling, input rights and export formats | Short muted loop, matching poster, mobile/reduced-motion fallback and performance checks |
| Recovery | Launch readiness | Neon plan/history limits, retention configuration, backup/restore permissions and operator availability | Measured restore drill against RPO<=1h/RTO<=8h targets; document any gap |
| Privacy and service policy | Launch readiness | Responsible contact, disclosure text, retention and deletion policy, client media authorization, third-party embeds review | Explicit owner review; no automatic claim of legal compliance |

## Environment variables

Names below reflect the PIN-only runtime. Messages and reports add no secret or provider dependency. PDF generation uses the pinned local PDFKit and DejaVu font packages and contacts no rendering service. Every secret remains server-only.

API URL examples use the origin `http://localhost:8080`; `/v1` belongs to the HTTP route path. The panel remains on `http://localhost:3000`, and the public demo remains on `http://localhost:4321`. `PUBLIC_SITE_ID=demo-wedding` is the deterministic environment-local demo identifier created by the provisioning command; it is not an authorization value.

Database integration tests use the isolated `DATABASE_URL_TEST` and verify its identity before running. The normal local and CI flow uses disposable PostgreSQL and applies migrations before the tests. See the [database operations guide](../packages/database/README.md) for Neon-specific test and deployment settings. Production API connections derive their endpoint, database, and role checks from `DATABASE_URL`.

| Variable | Consumer | Classification |
| --- | --- | --- |
| `PORT` | Node API | Server runtime port |
| `APP_ENV` | API configuration outside Railway production | Explicit environment selector; Railway production derives it from `RAILWAY_ENVIRONMENT_NAME` |
| `DATABASE_URL` | API / migration destination check | Secret on deployed environments |
| `DATABASE_DIRECT_URL` | Migration process | Direct connection with a migration role |
| `DATABASE_URL_TEST` | Test API / integration tests | Isolated disposable database |
| `DATABASE_MIGRATION_HOST` | Deployment migration destination check | Expected direct Neon hostname |
| `BETTER_AUTH_SECRET` | API | Secret; separate per environment |
| `BETTER_AUTH_URL` | API outside Railway | Auth endpoint base URL; Railway derives it from `RAILWAY_PUBLIC_DOMAIN` |
| `ADMIN_ORIGIN` | API | Explicit trusted admin origin |
| `GUEST_FINGERPRINT_SECRET` | API | Secret HMAC key for phone/IP fingerprints and domain-separated group PIN derivation |
| `TRUST_PROXY_HEADERS` | API outside Railway | Explicit opt-in for trusted proxies; Railway automatically trusts its documented `X-Real-IP` header |
| `PUBLIC_API_URL` / `PUBLIC_SITE_ID` | Astro build | Public API origin and environment-local wedding identifier; never authorization |
| `VITE_API_URL` / `API_BASE_URL` | Admin BFF/runtime | Endpoint address only; never a credential |

## Demo environment provisioning

The API includes an internal `environment:provision` command for the isolated `development` and `production` Railway environments. Run it from the repository root through a Railway shell or `railway run`, so Railway supplies the selected environment's `DATABASE_URL` and `RAILWAY_ENVIRONMENT_NAME`. Never paste a database URL into this document or into a command history.

The command requires these values:

| Variable | Required value or rule |
| --- | --- |
| `ENTRELACOS_DATABASE_TARGET` | `development` or `production`; must equal `RAILWAY_ENVIRONMENT_NAME` |
| `RAILWAY_ENVIRONMENT_NAME` | Supplied by Railway; must equal `ENTRELACOS_DATABASE_TARGET` |
| `ENTRELACOS_PROVISION_CONFIRM` | Exact `PROVISION <target> demo-wedding` |
| `ENTRELACOS_PRODUCTION_PROVISION_AUTHORIZED` | Production only: exact `PROVISION production environment` |
| `ENTRELACOS_DEMO_PUBLIC_URL` | The public demo URL for the selected environment; it must match the deployed Worker origin |
| `ENTRELACOS_OWNER_EMAIL` | Authorized owner email |
| `ENTRELACOS_OWNER_NAME` | Authorized owner display name |
| `ENTRELACOS_OWNER_PASSWORD` | Owner bootstrap input; keep it out of command arguments and logs |
| `ENTRELACOS_DEMO_RESET_CONFIRM` | Optional exact `RESET <target> demo-wedding`; required only for explicit recovery/reset |

Use a Bash-compatible shell and enter private values interactively. The password is held in a process variable for the child command, not written in shell history or printed:

```bash
read -r -p "Owner email: " ENTRELACOS_OWNER_EMAIL
read -r -p "Owner name: " ENTRELACOS_OWNER_NAME
read -r -p "Demo public URL: " ENTRELACOS_DEMO_PUBLIC_URL
read -r -s -p "Owner password: " ENTRELACOS_OWNER_PASSWORD
printf '\n'
export ENTRELACOS_OWNER_EMAIL ENTRELACOS_OWNER_NAME ENTRELACOS_DEMO_PUBLIC_URL ENTRELACOS_OWNER_PASSWORD
```

Provision development:

```bash
export ENTRELACOS_DATABASE_TARGET=development
export ENTRELACOS_PROVISION_CONFIRM='PROVISION development demo-wedding'
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = development ] || { echo "Wrong Railway environment" >&2; exit 1; }
# Optional explicit recovery: export ENTRELACOS_DEMO_RESET_CONFIRM='RESET development demo-wedding'
bun run --filter=@entrelacos/api environment:provision
unset ENTRELACOS_DATABASE_TARGET ENTRELACOS_PROVISION_CONFIRM ENTRELACOS_OWNER_EMAIL ENTRELACOS_OWNER_NAME ENTRELACOS_OWNER_PASSWORD ENTRELACOS_DEMO_PUBLIC_URL ENTRELACOS_DEMO_RESET_CONFIRM
```

Provision production requires the additional explicit authorization gate:

```bash
export ENTRELACOS_DATABASE_TARGET=production
export ENTRELACOS_PROVISION_CONFIRM='PROVISION production demo-wedding'
export ENTRELACOS_PRODUCTION_PROVISION_AUTHORIZED='PROVISION production environment'
[ "${RAILWAY_ENVIRONMENT_NAME:-}" = production ] || { echo "Wrong Railway environment" >&2; exit 1; }
# Optional explicit recovery: export ENTRELACOS_DEMO_RESET_CONFIRM='RESET production demo-wedding'
bun run --filter=@entrelacos/api environment:provision
unset ENTRELACOS_DATABASE_TARGET ENTRELACOS_PROVISION_CONFIRM ENTRELACOS_PRODUCTION_PROVISION_AUTHORIZED ENTRELACOS_OWNER_EMAIL ENTRELACOS_OWNER_NAME ENTRELACOS_OWNER_PASSWORD ENTRELACOS_DEMO_PUBLIC_URL ENTRELACOS_DEMO_RESET_CONFIRM
```

A normal rerun preserves an existing valid demo site and its operational rows. A partial site, owner, or dataset fails closed; it does not automatically reset data. Recovery requires adding the exact target-specific confirmation to the corresponding command before rerunning: `RESET development demo-wedding` for development or `RESET production demo-wedding` for production.

The reset is transactional for the demo dataset and re-enables the mural afterward. Do not add reset confirmation to routine deploy or rerun commands. A successful provision reports whether the site was created or preserved and whether the deterministic dataset was reset or preserved.

Do not copy development secrets or database rows to main. A stable repository wedding key maps to separate environment-local IDs. Public URLs and environment IDs may be versioned when appropriate; tokens, passwords and PII are not fixture configuration.

## Manual launch checklist

1. Prepare the main wedding record through the authorized API workflow; do not import development guests or sessions.
2. Review production migrations and verify the Database CD run for the release commit before publishing the API.
3. Build and publish the site/panel/API manually with the correct public configuration and server secrets.
4. Register exact URLs/origins and owner-entered status in the central panel when that feature exists.
5. Issue the bride's activation link. Production review is public; remind admins not to circulate the link yet.
6. Preserve genuine data entered during review. Record approval and the service term after acceptance.
7. For later deactivation, update API state and separately change hosting to an unavailable page or stop serving all public addresses, including workers.dev. Preserve data and keep operational read/export access.

## Open engineering inputs

The invitation access policy is 10 phone/PIN attempts per IP per 15 minutes, with a per-invitation cooldown after repeated incorrect PINs. The site-scoped registered phone and six-digit manual PIN grant access without a guest name or SMS lookup. The guest browser transport is an `Authorization` bearer held only in site-namespaced `sessionStorage`. The separate admin-to-public handoff remains a later cross-origin decision.

## Listening

Block 3 keeps `DATABASE_URL` as the development connection and `DATABASE_URL_TEST` as the only integration-test connection. Guest verification is provider-free and PIN-only. Forwarded IP headers are ignored unless the deployment explicitly declares a trusted proxy boundary.

Block 4 keeps persistence in the existing Neon topology. RSVP writes, revision checks, history entries, and idempotency receipts are one transactional unit; concurrency and tenant isolation require real PostgreSQL evidence against the disposable test resource. The admin deadline input stores an explicit UTC instant plus IANA timezone. No communication-provider credential is needed to validate an authenticated RSVP.
