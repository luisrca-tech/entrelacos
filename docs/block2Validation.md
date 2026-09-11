# Block 2 implementation and validation

Status: complete on 2026-09-11. Chrome acceptance is closed; Safari is additional and non-blocking.

## Accepted contract

- OWNER has global access; SITE_ADMIN belongs to one wedding.
- Activation and controlled recovery use hashed, single-use, 24-hour tokens. Issuing another recovery token invalidates the previous token. Completing recovery revokes every account session and its derived site recognition.
- Activation sets the password and then requires explicit login. Public signup and automatic email are disabled.
- Administrative sessions expire after 24 hours idle and seven days absolutely. Logout revokes the current session and its derivatives; account deactivation revokes all account sessions.
- Site lifecycle is DRAFT, IN_REVIEW, ACTIVE, or INACTIVE. Manual reactivation restores the previous state and preserves the term. Review approval starts an editable one-year term. Expiration does not automatically deactivate or delete data.
- Site status, public deployment, domain status, and service term are separate records. Inactive sites preserve operational data and administrative read/export eligibility; report generation remains in its designated later block.
- Better Auth remains in the Hono API under /v1/auth. The panel has no database access. The static site receives only site-bound, revocable recognition, never the administrative session credential.
- The cross-site experiment is a blocking prerequisite for integrating the final browser flow. It includes an isolated transport proof for future guest sessions, without implementing guests, OTP, or RSVP.

## Preflight evidence

- Implementation branch: `block-2/site-lifecycle-admin-access`.
- Base: `f9bcd16671715bd6588b0d78cfbd0afb2ec5858c`; local HEAD and remote main matched through an authenticated SSH read. The existing HTTPS remote was preserved.
- Frozen Bun installation, lint, seven forced typecheck tasks, four scaffold tests, and three forced builds passed before product changes.
- Read-only Neon queries returned distinct actual branch IDs for development and testing. Both had no application tables. Private expected identities were saved locally for subsequent fail-closed checks.
- The commented production endpoint was compared locally against development/testing and was distinct. No production connection was made.
- The existing database environment file was preserved, with expected identity fields appended. The ignored API environment file was created with the approved local URL and a privately generated secret.
- Detailed private destination evidence is in ignored `work/block-2/preflight.json`.

## Delivered implementation

- T3: strict shared contracts, one-site membership and access-token constraints,
  reviewed `0001_block2_contracts.sql`, and real constraint tests.
- T4: controlled activation/recovery, explicit login, account disabling, restricted
  OWNER recovery, and complete session/recognition revocation.
- T5/T6: lifecycle/domain/date services and administrative login/access screens.
- T7: OWNER wedding chooser and operational forms; SITE_ADMIN scoped read view.
- T8: first-party Workers BFF and static-site challenge-bound recognition.
- T9: independent Chrome QA and real PostgreSQL regression checks, detailed below.
- T10: development migrations applied twice; initial OWNER bootstrap created the
  account, then preserved it on repetition. Block 3 contracts are documented in
  `block2Handoff.md`.

## Browser evidence

The final application uses the built Node API, native HTTPS Workers/Vite panel,
Astro static output, and the actual test database. Its distinct HTTPS origins
are `panel-entrelacos.test:3000`, `api-entrelacos.test:18443`, and
`demo-entrelacos.test:18443`. Certificate trust was limited to the generated
certificate fingerprint; browser same-origin protections remained enabled.
A first-party cookie probe succeeded while the equivalent cross-site request
omitted the cookie even with credentials included.

The user reported successful Chrome login, site recognition, panel return,
logout, invalid-session denial, and direct visitor access. The user explicitly
accepted Chrome for final Block 2 acceptance and made Safari an additional test
that does not block Block 3. Responsive Chrome is not evidence of Safari or a
physical mobile browser. The earlier iPhone LAN attempt did not establish a
usable Safari test connection.

Independent black-box QA covers the actual OWNER chooser, lifecycle and date
forms, domain persistence/conflicts, manual admin access issuance, public visitor
navigation, handoff, refresh, panel return, and cross-tab logout. Desktop and
390-by-844 views have no horizontal overflow. Parent-controlled private fixtures
cover password entry; credentials and manual access tokens are excluded from
screenshots and reports. Local evidence is kept outside the repository under
`/tmp/entrelacos-block2-qa/evidence` and in ignored `work/block-2/`.

The earlier isolated future-guest transport proof remained independent of admin
logout. It is an experiment only: guest groups, OTP, guest sessions, and RSVP are
not implemented by Block 2.

## Defects corrected before acceptance

- Fixed migration ordering so the composite membership unique index exists before
  its dependent foreign key.
- Fixed nested site response envelopes, HTTP service-error conversion, and
  PostgreSQL unique-conflict handling.
- Fixed concurrent idempotent creation when a second request misses the key but
  finds the same key through the slug lookup; a deterministic regression and real
  concurrent PostgreSQL test cover the interleaving.
- Serialized login and password reset with a transaction-scoped PostgreSQL
  advisory lock. Better Auth runs inside that same transaction, preventing an
  in-flight old-password login from leaving a valid session after recovery.
  The regression exercises the real HTTP login route and PostgreSQL barrier.
- Declared `pg` as an API runtime dependency so the built Node ESM application
  starts without a bundled CommonJS dynamic-require failure.
- Moved the public administrative strip into the template layout slot so it does
  not overlap the wedding header on narrow viewports.

## Validation status

`bun run check` passed: lint, all seven typecheck tasks, 99 unit tests across
19 files, and all three builds (fresh build executions). `bun run test:db`
passed 25 real PostgreSQL tests across eight files, with serialized writes.
Expected Better Auth rejection logs occurred for pending/disabled users and an
old password; these are asserted negative cases, not unexplained failures.

Independent tenant-isolation checks returned 404 and an unavailable-access UI
for the other wedding, twice. The initially reported isolation failure was a
fixture-ID mix-up and was corrected by retesting the actual second wedding.
Creation replay returned the same ID and a single card; conflicting references
returned 409 twice. The parent completed the independent runner's remaining
manual-revocation item by targeting the new administrator's row explicitly;
the revoke endpoint and subsequent reloads returned 200.

The real recovery screen set the password, removed the token fragment, required
explicit login, and left `/v1/me` returning 401 until login. Direct browser
checks against owned fixtures returned 401 at both idle and absolute session
expiry. The public Painel link was corrected to open the central panel directly
when a session already exists; challenge handoff remains on panel-to-site
navigation. Neutral static output was also opened in Chrome, with no couple
content or horizontal overflow.

Development OWNER login, role resolution, and logout passed after bootstrap.
Cleanup removed only identified QA users/sites, their dependent records, owned
recognition records, and one fixture left by the previously failing concurrency
test. Test helpers, certificates, credentials, and screenshots are unversioned.

Static inactive output was built independently and contains the neutral message
without the wedding content. Deactivation itself does not deploy hosting changes:
`block2Lifecycle.md` requires the neutral build on every custom hostname and
`workers.dev`. Publication, lifecycle, domain state, and term remain independent.

## Listening

The accepted design keeps administrative credentials first-party in the panel and
uses only revocable cosmetic recognition on public sites. The final Workers
integration was tested separately from the earlier transport prototype. The user
explicitly selected Chrome acceptance; Safari remains additional rather than an
unfulfilled prerequisite. No deployment or production database mutation is part
of this delivery. Block 3 must preserve the boundaries in `block2Handoff.md`.
