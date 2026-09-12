# Block 4 validation record

Status: **PASS** for the authorized local Block 4 boundary on `block-4/member-rsvp` as of 2026-09-12. Contracts, database migrations, PostgreSQL behavior, static privacy, desktop/mobile browser flows, and final repository gates passed. No production system was accessed.

## Database and migrations

The isolated test connection was read from `DATABASE_URL_TEST`; it did not fall back to `DATABASE_URL`. The target was verified as the dedicated Neon test endpoint in `sa-east-1`, database `neondb`, role `neondb_owner`. Development used only `DATABASE_URL`. No connection string or credential is recorded here.

The reviewed migrations were applied in this order:

1. `0005_youthful_sasquatch.sql` adds RSVP state/revision, the nullable deadline pair, transition history, and request receipts.
2. `0006_fancy_preak.sql` corrects the idempotency uniqueness boundary to include `site_id`.

Both migrations completed first against `--target=test` and then against `--target=development`. Production was never connected, tested, or migrated.

## Automated evidence

| Command or check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS; lockfile installed without mutation |
| Focused RSVP PostgreSQL suites | PASS; 2 files and 15 tests after the tenant-scoped receipt fix |
| `bun run check` | PASS; Biome, 8-package typecheck, 32 unit/contract files with 159 tests, and all builds |
| `bun run test:db` | PASS; 17 PostgreSQL files and 76 tests |
| Static wedding demo build | PASS without live API, database, or SMS dependency at build time |
| Static artifact privacy scan | PASS; 5 generated files, zero fixture group/member IDs, names, phones, credentials, or authenticated-state values |
| `git diff --check` | PASS after final source and documentation edits |
| `graphify update .` | PASS; 1,717 nodes, 3,327 edges, and 103 communities |

The PostgreSQL suites cover reads without mutation, partial and pending responses, deadline boundaries, post-deadline administrative correction, no-op and replay behavior, same-member and different-member concurrency, all-or-nothing conflicts, cross-group/site rejection, foreign groups, spelling preservation, inactive sites, CORS, and expired/revoked sessions. The same administrative actor also reuses one request ID across two weddings without cross-site replay.

Graphify still reports its known Astro parser limitation for three `.astro` files and omits generated migration snapshots that produce no AST nodes. Source, typecheck, tests, builds, and browser evidence corroborate the affected paths.

## Independent browser QA

A dedicated black-box subagent used `agent-browser` with synthetic authorized identities against isolated local origins. It did not inspect source or mutate the database directly. The sanitized report is stored outside the repository at `/tmp/entrelacos-b4-qa/run/report.md`.

Browser PASS evidence covers:

- admin totals, group/status filters, separate current/history views, deadline timezone input, multi-member save, history filters, and sentinel wedding isolation;
- restored family session, two-member modal, read without write, local draft, confirm-all without save, partial save, persistence, and history;
- conflict feedback, preservation of local selection, reload/retry, deadline read-only behavior, and active-site admin correction after the deadline;
- induced network failure with no false success and successful recovery;
- the shared mobile form at 390x844 with no horizontal overflow, usable focus, and Escape close;
- console and URL inspection without page errors or credential-bearing URLs.

The first revocation run found one defect: a public save received `401` but returned to lookup without an expired-session message and could retain `Acesso confirmado.`. The fix now clears session/draft/modal state, removes stale notices, and shows `Esta sessão expirou. Comece novamente.`. A fresh independent rerun reproduced the `401` and passed with no stale or false-success message.

History pagination was not rendered in the browser fixture because it contained fewer than 50 entries. Cursor ordering, pagination, malformed cursors, and filters are covered by contract and PostgreSQL tests.

## Defects corrected during validation

- Same-member concurrent test data could submit one no-op state; it now always submits two distinct states, proving one success and one conflict.
- The HTTP expiry fixture violated the existing seven-day session constraint; its timestamps now model a valid session before testing exact expiry.
- Request receipts were keyed without `site_id`; lookup, advisory locking, schema uniqueness, migration, and a two-wedding regression now use the wedding scope.
- Revoked family sessions did not leave visible feedback after an RSVP save; the public controller now clears stale success state and exposes the session-expired error.
- The disabled admin save label rendered an incorrect plural; it now reads `Salvar alterações`.

## Limits

This validation proves the local development and isolated test boundary only. It does not prove a public deployment, production migration, real Twilio delivery, production monitoring, or the final Block 6 wedding design. Those remain outside Block 4.

## Listening

The final evidence separates mocked contracts, real PostgreSQL behavior, static artifact privacy, and black-box browser behavior. The corrective receipt migration was kept separate because the first migration had already been reviewed and applied. The independent QA failure was fixed and rerun before acceptance rather than documented as a known product limitation.
