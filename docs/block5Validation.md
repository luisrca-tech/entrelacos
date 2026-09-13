# Block 5 validation record

Status: **PASS** for the authorized local Block 5 boundary on `block-5/messages-exports-sms` as of 2026-09-12. Messages, the runtime mural, moderation, confirmed group deletion, RSVP exports, and monthly SMS accounting passed contract, PostgreSQL, browser, static privacy, and repository checks. No production system or SMS provider was accessed.

## Database and migrations

The isolated test connection was read from `DATABASE_URL_TEST`; it did not fall back to `DATABASE_URL`. The disposable Neon target identity was verified before mutation without recording its connection string or credentials. Development and production were not connected or migrated.

Migration `0007_windy_sage.sql` adds mural and group message state, message revisions and request receipts, deletion-safe RSVP receipt links, and site-period SMS usage and reservations. It also redacts legacy administrative RSVP receipts containing any member that no longer exists in the same site, then backfills group links for the remaining receipts. The reviewed migration was applied only to the verified test target. Because the test target had received an earlier draft, the same reviewed reconciliation statements were executed once against that test target to keep it aligned with the final migration; they reported zero remaining rows to redact or link.

## Automated evidence

| Command or check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS; 577 installs and 837 packages resolved without lockfile mutation |
| `bun run check` | PASS; Biome checked 194 files, all workspace typechecks/builds passed, and 48 unit/contract files passed 208 tests |
| `bun run test:db` | PASS; 23 PostgreSQL files and 103 tests |
| Focused Block 5 browser-support suites | PASS; 28 message/report tests, 12 admin tests, 6 report tests, and 37 focused PostgreSQL tests during black-box QA |
| Static wedding demo build | PASS without live API, database, or SMS at build time |
| Static artifact privacy scan | PASS; 20 generated admin/demo files inspected and no Block 5 QA fixture prefix, synthetic phone, PIN, or temporary path was found in the public demo output |
| `git diff --check` | PASS after implementation formatting and migration review |

The PostgreSQL suite covers identity snapshots, idempotent replay, concurrent revision conflicts, block and mural state, message deletion and republishing, tenant isolation, stable mural ordering, destructive group cascades, current and legacy RSVP receipt redaction, CSV/PDF snapshots, manual PIN independence, separate usage modes, exact quota boundaries, concurrent final-slot reservation, reservation outcomes, and the `America/Sao_Paulo` month boundary.

## Independent browser QA

A dedicated black-box agent used `agent-browser` with synthetic authorized identities against isolated local API, admin, and public-demo origins. It exercised supported UI and HTTP flows and removed its temporary fixtures, files, browser sessions, and local servers afterward.

Browser PASS evidence covers:

- OWNER login and manual family PIN verification;
- message publication and editing with emoji and line breaks, reload persistence, a real two-browser revision conflict, deletion, stale-editor protection, and republishing;
- anonymous mural privacy, stable rendering, mural enable/disable, and group message block/unblock without affecting RSVP;
- exact-name destructive confirmation, cancellation, mismatch rejection, repeat deletion, and revocation of the deleted group's old session;
- CSV and PDF downloads with and without representative phone, filters including empty results, formula-safe CSV values, Unicode, two-page PDF output, repeated headers, and A4 layout;
- missing and zero SMS limits, OWNER configuration, alerts, and manual PIN operation outside quota accounting;
- desktop and 390x844 mobile layouts without horizontal overflow, plus loading/error/failure feedback.

The QA run found and corrected two defects before rerunning the affected paths. Group mutations now notify the RSVP and message sections so their data refreshes without a full page reload. PDF table headers now share one vertical position on every page.

## Final review corrections

The final independent code review found and verified three further corrections:

- legacy administrative RSVP receipts with a previously deleted member are now redacted before migration backfill, including mixed receipts that also contain a retained member;
- missing or exhausted SMS quota now directs the guest to the wedding organization for the manual PIN instead of suggesting a futile retry;
- simulated SMS rejects any non-mock provider before database work or dispatch, preventing a configuration mistake from sending through a real provider.

The first full PostgreSQL rerun after these corrections exposed a test-isolation defect: the manual-PIN HTTP fixture used a fixed IP and did not remove its rate-limit records. The fixture now uses a run-unique IP and cleans both phone and IP fingerprints. Its focused suite passed twice consecutively, followed by a clean full 23-file PostgreSQL run.

## Limits

This record proves the local development build and isolated test database only. It does not prove a public deployment, development or production migration, real Twilio delivery or usage, provider costs, production monitoring, or legal retention policy. Real SMS remains closed until an OWNER configures a site limit and every provider authorization gate is satisfied; manual PIN is the expected MVP path.

Two pre-existing Block 2 browser limitations were observed outside this implementation: `GET /v1/owner/sites` without query parameters returns `400`, which prevents normal site selection on the OWNER home, and the SITE_ADMIN activation page did not render its activation form. Block 5 SITE_ADMIN authorization remains covered by focused automated tests; these limitations should be addressed before broader end-to-end release acceptance.

No commit, push, deployment, provider call, or production mutation was made.

## Listening

The validation separates deterministic quota accounting from provider evidence: simulated reservations prove concurrency and alert rules but never count as Twilio delivery, account usage, or cost. The RSVP receipt migration redacts a whole legacy response when any referenced member is already absent because the deleted member's group can no longer be recovered safely; retaining the rest would leave replayable private data with incomplete ownership.
