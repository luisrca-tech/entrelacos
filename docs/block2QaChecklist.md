# Block 2 acceptance checklist

Status: partially executed; Block 2 is not accepted. Checkmarks reference actual evidence in `block2Validation.md`. Experiment checks do not substitute for final application integration.

## Environment and persistence

- [x] Local and remote base verified; unrelated work preserved.
- [x] Test destination verified from Neon identity; missing/mismatched identity fails closed.
- [x] Reviewed foundation migration applied in testing; repeat application is harmless. Final schema migrations remain pending.
- [x] No production connection or mutation; private environment values stay ignored.
- [ ] Fixtures are distinct for weddings A and B and cleanup targets only owned IDs.

## Access workflows

- [ ] Public signup and unapproved Better Auth endpoints are unavailable.
- [ ] OWNER bootstrap creates credentials through library hashing and preserves an existing account.
- [ ] OWNER creates pending SITE_ADMIN for wedding A; account cannot log in before activation.
- [ ] Activation accepts one valid token exactly once, including concurrent redemption.
- [ ] Expired, revoked, malformed, and replaced activation tokens fail.
- [ ] Activation sets the password without creating a session; login email is prefilled.
- [ ] Recovery links require OWNER issuance; a new link revokes the old one.
- [ ] Recovery expires after 24 hours, is single-use, and forces a fresh login.
- [ ] Recovery revokes every session and derived recognition for that account.
- [ ] Account deactivation blocks new logins and existing sessions without deleting site data.
- [ ] OWNER recovery uses a restricted server procedure, never a public route.

## Sessions and browser transport

- [ ] Raw administrative session tokens never appear in browser-readable JSON or site storage.
- [ ] Idle expiry at 24 hours and absolute expiry at seven days reject access at the boundary.
- [ ] Session activity cannot extend the absolute deadline.
- [ ] Background recognition polling does not extend administrative inactivity.
- [ ] Logout remains in the panel and revokes only the current session and its derivatives.
- [x] A first-party cookie control succeeds while cross-site cookie transmission is blocked in desktop Chromium.
- [ ] Real login, refresh, handoff, return, and logout work across distinct HTTPS sites.
- [ ] Handoff rejects replay, wrong site, wrong origin, wrong proof, and arbitrary redirects.
- [ ] Recognition is site-bound and cannot authorize administrative operations.
- [ ] Recognition stops working after parent-session logout, expiry, recovery, or account deactivation.
- [ ] Desktop, mobile layout, and actual mobile-browser evidence are identified separately.
- [x] The isolated future guest transport proof is independent from administrative identity and revocation in desktop Chromium. Actual guest authentication belongs to Block 3.

## Lifecycle and panel

- [ ] Repeated and concurrent create/resume requests return the same wedding without overwriting data.
- [ ] OWNER sees the chooser; SITE_ADMIN enters its assigned wedding directly.
- [ ] SITE_ADMIN cannot list, discover, read, or mutate wedding B by changing identifiers.
- [ ] SITE_ADMIN cannot grant roles, change membership, or call OWNER operations.
- [ ] OWNER records URL, explicit origins, domain/publication state, review, approval, and term.
- [ ] Approval starts the default calendar-year term once; explicit date edits are preserved.
- [ ] Repeated approval does not silently reset the term; leap-day behavior is tested.
- [ ] Deactivation preserves data and switches SITE_ADMIN to operational read-only permissions.
- [ ] Reactivation restores the previous lifecycle state without renewing the term.
- [ ] Expiration alone causes no deletion, provider change, or automatic deactivation.
- [ ] Public inactive presentation is neutral; the manual static-hosting procedure covers all URLs.
- [ ] Open-site navigation uses the registered destination; the public Panel entry works on mobile and desktop.

## Completion

- [ ] Lint, forced types, unit tests, real database tests, and forced builds pass together.
- [ ] Development migrations and the authorized initial OWNER bootstrap are verified.
- [ ] Temporary experiment routes/bypasses do not ship with application builds.
- [ ] Graphify and implementation documentation reflect the final code.
- [ ] Block 3 receives stable tenant, authorization, lifecycle, test-database, and transport contracts.
- [ ] No Block 2 defect or missing evidence is silently deferred to Block 3.
