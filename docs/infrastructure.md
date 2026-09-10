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
| SMS policies | Abuse/usage task | Initial monthly per-site ceiling, additional IP limits, accounting periods/time zone, provider failure accounting | Concurrent requests cannot exceed reservations; alerts and block behavior verified |
| Domain / DNS | Optional custom domain task | Client domain ownership/access, domain provider account, DNS control, renewal responsibility | Verify correct deployment target and TLS; domain renewal remains external |
| Repository CI | CI publication | GitHub repository if selected later, runner access, read-only default workflow permissions | Frozen install/check; no main migration/deploy jobs; add test-only secrets with database suite |
| AI imagery | Media production task | Approved fictional couple reference, prompts, approved generation tool and usage terms | Consistent characters, approved crop/poster, no claim that generated photos depict the real venue |
| AI video | Hero media task | Provider/tool selection, access/key if needed, cost ceiling, input rights and export formats | Short muted loop, matching poster, mobile/reduced-motion fallback and performance checks |
| Recovery | Launch readiness | Neon plan/history limits, retention configuration, backup/restore permissions and operator availability | Measured restore drill against RPO<=1h/RTO<=8h targets; document any gap |
| Privacy and service policy | Launch readiness | Responsible contact, disclosure text, retention and deletion policy, client media authorization, third-party embeds review | Explicit owner review; no automatic claim of legal compliance |

## Environment variables

Names below are the initial register. Only `PORT` is consumed by the API liveness scaffold. Integrations validate their inputs when introduced; empty examples are not functioning connections.

| Variable | Consumer | Classification |
| --- | --- | --- |
| `PORT` | Node API | Server runtime port |
| `APP_ENV` | Planned API configuration | Environment selector; does not grant permission to main |
| `DATABASE_URL` | API / manually selected migration process | Secret; never frontend |
| `BETTER_AUTH_SECRET` | API | Secret; separate per environment |
| `BETTER_AUTH_URL` | API | Auth endpoint base URL; align configured route prefix |
| `ADMIN_ORIGIN` | API | Explicit trusted admin origin |
| `SMS_MODE` | API | Simulation/real test choice; main real weddings cannot use global simulation |
| `TWILIO_ACCOUNT_SID` | API | Server provider identifier |
| `TWILIO_AUTH_TOKEN` | API | Secret |
| `TWILIO_VERIFY_SERVICE_SID` | API | Server Verify service identifier |
| `TWILIO_TEST_PHONE_ALLOWLIST` | API | Private operator test phone list |
| `PUBLIC_API_URL` / `PUBLIC_SITE_ID` | Astro build | Public wedding configuration, never authorization |
| `VITE_API_URL` or server `API_BASE_URL` | Admin integration design | Endpoint address only; final BFF routing chosen by auth spike |

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

Set the initial SMS ceiling/IP policy and retention time zone during the corresponding task. Select the video tool during media preflight. Verify provider plan/limits and recovery costs then, not from an old pricing snapshot. Decide the browser credential transport based on the cross-origin experiment. None of these prerequisites blocks the credential-free scaffold.
