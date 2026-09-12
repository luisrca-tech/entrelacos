# Block 3 validation report

Status: PASS for local application, database, security review, and clean-browser acceptance through the manual group PIN redesign on 2026-09-12. Live Twilio delivery is pending by design.

## Delivered scope

- Tenant-bound guest-group and member administration for OWNER and assigned SITE_ADMIN roles.
- Exact normalized full-name and Brazilian-phone lookup, plus a permanent foreign-number administrative path.
- Persistent six-digit group PIN generation, authenticated transient reveal/copy, explicit rotation, expiring manual challenges, attempt limits, cooldown, and immediate old-access revocation.
- Optional SMS challenge, resend/expiry behavior, multi-scope send controls, simulation, provider outcomes, and Twilio fail-closed gates remain intact.
- Opaque seven-day family bearer sessions, site/group binding, explicit leave, and server-side revocation.
- Five-minute OWNER demo grants restricted by active demo marker, exact admin origin, destination allowlist, and site/phone binding.
- Twilio Verify v2 adapter with fail-closed authorization, credential, SID, country, trial/usage, and destination gates.
- Admin and public browser surfaces, including site-namespaced `sessionStorage` and exact-origin CORS.

## Automated evidence

| Command | Result | Coverage |
| --- | --- | --- |
| `bun run check` | PASS: lint, seven workspace typechecks, 137 unit tests in 27 files, and three application builds | Contracts, service branches, HTTP mapping, runtime gates, UI helpers, public client behavior, and production builds |
| `bun run test:db` | PASS: 61 PostgreSQL tests in 15 files | Constraints, migrations, manual PIN derivation/rotation, tenant isolation, transactional writes, concurrency limits, revocation, session hashing, SMS regression, and demo isolation |
| `bun run --cwd packages/database db:migrate -- --target=development` | PASS | Reviewed Block 3 migrations applied only to the configured development database |
| `git diff --check` | PASS | No whitespace errors in the working diff |

Focused black-box evidence for the redesign covers SITE_ADMIN group creation, PIN reveal/copy, manual lookup without a provider send, absent manual resend, wrong/current PIN handling, family rendering, rotation, active-session revocation, old-PIN rejection, replacement-PIN acceptance, and desktop/mobile overflow checks. A final public/admin console sweep found no application exceptions. Evidence paths and prior Block 3 coverage are recorded in `docs/block3QaChecklist.md`.

The database runner verifies the configured target identity and uses `DATABASE_URL_TEST` exclusively. Development migration is a separate explicit command using `DATABASE_URL`. No production URL was selected or migrated.

## Security evidence

- Raw family bearer tokens are returned once and only SHA-256 hashes are stored.
- Phone and IP abuse scopes use HMAC fingerprints; raw values are not stored in rate-limit records.
- Group PINs are derived with a domain-separated HMAC from a random 32-byte seed; neither plaintext PIN nor a brute-forceable plain PIN hash is stored.
- Provider dispatch occurs outside database transactions after an atomic reservation, followed by a challenge re-lock before state transition.
- Real provider codes are never stored locally. Mock codes are disclosed only to a valid demo grant when explicit development exposure is enabled.
- Wildcard origins, credentialed cross-site cookies, URL grants, and URL family tokens are absent.
- A phone or representative change revokes sessions and pending challenges; spelling-only changes preserve them.
- PIN rotation replaces the seed and revokes active sessions and pending challenges atomically.
- Inactive sites reject public work, while explicit leave still revokes an existing bearer.

## Defects found and corrected during final review

- Twilio invalid or exhausted checks now become `DECLINED` and consume local attempts; malformed provider results fail closed as `UNKNOWN`.
- A delayed failed send cannot clear the code from a newer resend, and each HTTP response is tied to its exact send reservation.
- `FAILED_FINAL` never returns or retains a simulated code in the API or public UI.
- Malformed JSON cannot trigger a family-session leave.
- Demo-grant expiry is serialized to the contract's ISO instant instead of returning a validation error.
- The browser `fetch` function is invoked without rebinding its receiver, restoring actual cross-origin requests outside Node mocks.
- Manual challenges create no provider-send record, expose no resend control, and use PIN-specific labels and errors.
- Deleting the currently revealed group clears its transient PIN from administrative UI state.

## External gate

No real SMS was sent. The manual group PIN is the operational MVP path and needs no Twilio service. Live SMS acceptance still requires all provider gates at the same time: Twilio credentials, valid Account and Verify Service SIDs, explicit real-SMS authorization, a non-empty destination allowlist, confirmed Brazilian geo permission, confirmed account usage constraints, and a separate instruction to send to the approved destination. Manual or mock success is not provider evidence.

## Remaining work outside Block 3

- Monthly per-site SMS ceilings and dashboard alerts belong to Block 5.
- RSVP states, deadline, optimistic concurrency, and history belong to Block 4.
- Complete deterministic demo reset and broad end-to-end product QA belong to Block 7.
- Production migration, deployment, DNS, and provider activation remain manual release gates.

## Listening

The manual PIN is persistent at group scope while its verification challenge stays short-lived. Plaintext and plain-hash storage were rejected; the random seed plus server HMAC permits authorized repeat reveal and explicit rotation without weakening database-only compromise resistance. The public browser continues to use tab-scoped bearer storage because independent static origins cannot rely on first-party administrative cookies.
