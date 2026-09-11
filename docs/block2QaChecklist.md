# Block 2 acceptance checklist

Status: complete on 2026-09-11. Evidence and its browser/database boundaries are recorded in `block2Validation.md`. Safari is an additional non-blocking test by explicit user acceptance.

## Environment and persistence

- [x] Local and remote base verified; unrelated work preserved.
- [x] Test destination verified from Neon identity; missing/mismatched identity fails closed.
- [x] Both reviewed migrations applied in testing and development; repeated application is harmless.
- [x] No production connection or mutation; private environment values stay ignored.
- [x] Fixtures are distinct for weddings A and B and cleanup targets only owned IDs.

## Access workflows

- [x] Public signup and unapproved Better Auth endpoints are unavailable.
- [x] OWNER bootstrap creates credentials through library hashing and preserves an existing account.
- [x] OWNER creates pending SITE_ADMIN for wedding A; account cannot log in before activation.
- [x] Activation accepts one valid token exactly once, including concurrent redemption.
- [x] Expired, revoked, malformed, and replaced activation tokens fail.
- [x] Activation sets the password without creating a session; login email is prefilled.
- [x] Recovery links require OWNER issuance; a new link revokes the old one.
- [x] Recovery expires after 24 hours, is single-use, and forces a fresh login.
- [x] Recovery revokes every session and derived recognition for that account.
- [x] Account deactivation blocks new logins and existing sessions without deleting site data.
- [x] OWNER recovery uses a restricted server procedure, never a public route.

## Sessions and browser transport

- [x] Raw administrative session tokens never appear in browser-readable JSON or site storage.
- [x] Idle expiry at 24 hours and absolute expiry at seven days reject access at the boundary.
- [x] Session activity cannot extend the absolute deadline.
- [x] Background recognition polling does not extend administrative inactivity.
- [x] Logout remains in the panel and revokes only the current session and its derivatives.
- [x] A first-party cookie control succeeds while cross-site cookie transmission is blocked in desktop Chromium.
- [x] Real login, refresh, handoff, return, and logout work across distinct HTTPS sites.
- [x] Handoff rejects replay, wrong site, wrong origin, wrong proof, and arbitrary redirects.
- [x] Recognition is site-bound and cannot authorize administrative operations.
- [x] Recognition stops working after parent-session logout, expiry, recovery, or account deactivation.
- [x] Desktop, mobile layout, and actual mobile-browser evidence are identified separately.
- [x] The isolated future guest transport proof is independent from administrative identity and revocation in desktop Chromium. Actual guest authentication belongs to Block 3.

## Lifecycle and panel

- [x] Repeated and concurrent create/resume requests return the same wedding without overwriting data.
- [x] OWNER sees the chooser; SITE_ADMIN enters its assigned wedding directly.
- [x] SITE_ADMIN cannot list, discover, read, or mutate wedding B by changing identifiers.
- [x] SITE_ADMIN cannot grant roles, change membership, or call OWNER operations.
- [x] OWNER records URL, explicit origins, domain/publication state, review, approval, and term.
- [x] Approval starts the default calendar-year term once; explicit date edits are preserved.
- [x] Repeated approval does not silently reset the term; leap-day behavior is tested.
- [x] Deactivation preserves data and switches SITE_ADMIN to operational read-only permissions.
- [x] Reactivation restores the previous lifecycle state without renewing the term.
- [x] Expiration alone causes no deletion, provider change, or automatic deactivation.
- [x] Public inactive presentation is neutral; the manual static-hosting procedure covers all URLs.
- [x] Open-site navigation uses the registered destination; the public Panel entry works on mobile and desktop.

## Completion

- [x] Lint, all typecheck tasks, unit tests, real database tests, and fresh builds pass.
- [x] Development migrations and the authorized initial OWNER bootstrap are verified.
- [x] Temporary experiment routes/bypasses do not ship with application builds.
- [x] Graphify and implementation documentation reflect the final code.
- [x] Block 3 receives stable tenant, authorization, lifecycle, test-database, and transport contracts.
- [x] No Block 2 defect or missing evidence is silently deferred to Block 3.
