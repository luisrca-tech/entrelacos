# Block 3 validation report

Status: PASS for local application, database, security review, and clean-browser acceptance on 2026-09-11. Live Twilio delivery is pending by design.

## Delivered scope

- Tenant-bound guest-group and member administration for OWNER and assigned SITE_ADMIN roles.
- Exact normalized full-name and Brazilian-phone lookup, plus a permanent foreign-number administrative path.
- Six-digit OTP challenge, resend/expiry behavior, multi-scope abuse controls, cooldown, and provider-outcome handling.
- Opaque seven-day family bearer sessions, site/group binding, explicit leave, and server-side revocation.
- Five-minute OWNER demo grants restricted by active demo marker, exact admin origin, destination allowlist, and site/phone binding.
- Twilio Verify v2 adapter with fail-closed authorization, credential, SID, country, trial/usage, and destination gates.
- Admin and public browser surfaces, including site-namespaced `sessionStorage` and exact-origin CORS.

## Automated evidence

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run check` | PASS: lint, seven workspace typechecks, 136 unit tests in 27 files, and three application builds | Contracts, service branches, HTTP mapping, runtime gates, UI helpers, public client behavior, and production builds |
| `bun run test:db` | PASS: 58 PostgreSQL tests in 15 files | Constraints, migrations, tenant isolation, transactional writes, concurrency limits, revocation, session hashing, and demo isolation |
| `bun run --cwd packages/database db:migrate -- --target=development` | PASS | Reviewed Block 3 migrations applied only to the configured development database |
| `git diff --check` | PASS | No whitespace errors in the working diff |

Independent black-box evidence covers OWNER group administration, demo isolation, exact/approximate/foreign lookup outcomes, simulated OTP, resend countdown, wrong and correct codes, family rendering, refresh, spelling preservation, representative revocation, explicit leave, sentinel preservation, and desktop/mobile overflow checks. A final focused public/admin console sweep found no application exceptions. Evidence paths and the rate-limit note are recorded in `docs/block3QaChecklist.md`.

The database runner verifies the configured target identity and uses `DATABASE_URL_TEST` exclusively. Development migration is a separate explicit command using `DATABASE_URL`. No production URL was selected or migrated.

## Security evidence

- Raw family bearer tokens are returned once and only SHA-256 hashes are stored.
- Phone and IP abuse scopes use HMAC fingerprints; raw values are not stored in rate-limit records.
- Provider dispatch occurs outside database transactions after an atomic reservation, followed by a challenge re-lock before state transition.
- Real provider codes are never stored locally. Mock codes are disclosed only to a valid demo grant when explicit development exposure is enabled.
- Wildcard origins, credentialed cross-site cookies, URL grants, and URL family tokens are absent.
- A phone or representative change revokes sessions and pending challenges; spelling-only changes preserve them.
- Inactive sites reject public work, while explicit leave still revokes an existing bearer.

## Defects found and corrected during final review

- Twilio invalid or exhausted checks now become `DECLINED` and consume local attempts; malformed provider results fail closed as `UNKNOWN`.
- A delayed failed send cannot clear the code from a newer resend, and each HTTP response is tied to its exact send reservation.
- `FAILED_FINAL` never returns or retains a simulated code in the API or public UI.
- Malformed JSON cannot trigger a family-session leave.
- Demo-grant expiry is serialized to the contract's ISO instant instead of returning a validation error.
- The browser `fetch` function is invoked without rebinding its receiver, restoring actual cross-origin requests outside Node mocks.

## External gate

No real SMS was sent. Live acceptance requires all of the following at the same time: Twilio credentials, valid Account and Verify Service SIDs, explicit real-SMS authorization, a non-empty destination allowlist, confirmed Brazilian geo permission, confirmed account/trial usage constraints, and a separate instruction to send to the approved destination. Mock success is not provider evidence.

## Remaining work outside Block 3

- Monthly per-site SMS ceilings and dashboard alerts belong to Block 5.
- RSVP states, deadline, optimistic concurrency, and history belong to Block 4.
- Complete deterministic demo reset and broad end-to-end product QA belong to Block 7.
- Production migration, deployment, DNS, and provider activation remain manual release gates.

## Listening

The implementation reduced brute-force exposure with concrete IP limits while retaining the approved per-group and global-phone limits. The public browser uses tab-scoped bearer storage because independent static origins cannot rely on first-party administrative cookies; the separate admin handoff is intentionally not treated as solved by this guest flow.
