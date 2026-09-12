# Block 4 end-to-end QA checklist

Status: executed on 2026-09-12 with one independent `$qa-and-fix` executor using `agent-browser`. The initial run found an expired-session feedback defect; the fixed-build rerun passed. The detailed result matrix, automated coverage, limits, cleanup, and sanitized evidence location are recorded in `docs/block4Validation.md`. The unchecked items below remain the reusable execution checklist rather than a second result ledger.

## Preconditions and identity

- [ ] Confirm the branch and working tree, preserving unrelated local changes.
- [ ] Confirm the API, admin, and public demo origins are distinct and registered for the fixture wedding.
- [ ] Verify the disposable PostgreSQL project, branch, database, and role before mutation. Use `DATABASE_URL_TEST` only for test setup and tests; never use `DATABASE_URL` as a fallback.
- [ ] Apply the reviewed Block 4 migration to the isolated test database before database-backed QA. Apply to development separately only after review. Never connect to production.
- [ ] Use synthetic names, phones, PINs, sessions, and credentials. Do not use personal phones, Twilio credentials, real SMS, or production data.
- [ ] Create deterministic fixtures for two weddings, at least two groups, a multi-member Brazilian group, a one-member group, a foreign-number group, an active wedding, and an inactive sentinel wedding. Keep sentinel data unchanged.
- [ ] Create authorized `OWNER`, assigned `SITE_ADMIN`, and valid family-session identities through the approved test setup. Do not use route IDs, demo grants, or static flags as authorization.
- [ ] Serialize fixture setup, migration, mutating tests, browser writes, and cleanup against the shared disposable database.

## Public representative flow

- [ ] Start from a valid Block 3 family session created through exact lookup and manual group PIN verification; confirm the existing bearer is reused.
- [ ] Confirm the public RSVP read lists every member in the exact authenticated group, including representative labeling and current `PENDING` state.
- [ ] Open the RSVP form and verify that reading or opening it causes no member revision or history change.
- [ ] Change one member locally and verify the API is not called until “Salvar respostas” is activated.
- [ ] Use “Confirmar todos”, close/reopen or inspect the draft, and confirm no server state changes before explicit save.
- [ ] Save a full response and verify every submitted member has the requested state, one revision increment, and one corresponding history transition.
- [ ] Save a partial response while another member remains `PENDING`; verify the omitted member is unchanged.
- [ ] Leave all members `PENDING`; verify no automatic `DECLINED` state appears.
- [ ] Submit a no-op with current revisions; verify `NO_CHANGE` and no history transition.
- [ ] Simulate a lost response and retry the identical request after the server deadline; verify the stored response is replayed with `replayed: true` and no duplicate history.
- [ ] Retry the same request ID with a changed payload; verify `IDEMPOTENCY_KEY_REUSED` and no state change.
- [ ] Confirm a stale session or session revoked while the form is open clears/blocks the flow honestly and never reports false success.
- [ ] Confirm stale SMS/Twilio challenge state does not block RSVP after a valid family session exists.

## Deadline and inactive lifecycle

- [ ] Configure a deadline with an explicit IANA timezone through the admin UI and verify the stored UTC instant matches the selected wall-clock value.
- [ ] Verify invalid timezone and nonexistent local wall-clock values are rejected with accessible feedback and no partial deadline write.
- [ ] Exercise server time immediately before the deadline; verify public read says `canEdit: true`.
- [ ] Exercise server time exactly at the deadline; verify public read says `canEdit: false` and `readOnlyReason: DEADLINE_PASSED`.
- [ ] Exercise server time after the deadline; verify public reads remain available and show the server-derived read-only explanation.
- [ ] Attempt a new public save at and after the deadline; verify `409 RSVP_DEADLINE_PASSED`, no member/revision/history change, and no false success message.
- [ ] Verify an authorized `OWNER` and assigned `SITE_ADMIN` can record/correct an active wedding's member state after the deadline.
- [ ] Verify an inactive wedding remains readable to authorized admin operations but rejects admin writes with `SITE_INACTIVE`.
- [ ] Verify public RSVP access for the inactive wedding is rejected through the existing session boundary and does not disclose members.
- [ ] Verify `PENDING` remains `PENDING` across deadline, administrative correction of other members, and preparation for later exports.

## Concurrency and tenant isolation

- [ ] Open two clients with current revisions for the same member, submit different states concurrently, and verify exactly one succeeds.
- [ ] Verify the losing response uses machine code `RSVP_CONFLICT` and includes current conflicting member state/revision details.
- [ ] Verify a multi-member submission with one stale member rolls back every submitted member and every history row.
- [ ] Verify two concurrent submissions for different members both succeed when each expected revision is current.
- [ ] In the public UI, confirm a conflict preserves local selections, explains that data changed, refreshes current revisions, and offers review/retry.
- [ ] Verify a conflict for one member does not block a later safe update to an unrelated member.
- [ ] Attempt member IDs from another group and another wedding with a valid family/admin identity; verify rejection and no cross-tenant data leak.
- [ ] Read history for each wedding and verify entries from the other wedding never appear, including with group/member/cursor manipulation.
- [ ] Reuse one request ID for the same administrative actor across two weddings; verify no receipt replay, response data, or state crosses the site boundary.
- [ ] Verify foreign-number groups stay on the administrative path and cannot be used to create public RSVP access.

## Administrative current view

- [ ] Open the authenticated admin RSVP view with `OWNER` and assigned `SITE_ADMIN`; verify the site scope is derived from the authenticated account.
- [ ] Verify current view is separate from history and shows totals for `PENDING`, `CONFIRMED`, and `DECLINED`.
- [ ] Filter current data by group and state; verify members and group totals match the filter contract.
- [ ] Update one member and several members through an explicit save action; verify only changed members are submitted.
- [ ] Verify admin no-op and idempotent retry do not invent history transitions.
- [ ] Verify exact admin origin is required before session/service access, and a second wedding is denied to a site-assigned admin.

## Administrative history view

- [ ] Open history in its own tab/view without replacing current operations.
- [ ] Verify each row includes group, member, before state, after state, actor type, actor ID/display identity, and timestamp.
- [ ] Filter by group, member, `FAMILY`/`ADMIN`, before/after state, and time range where exposed by the API contract.
- [ ] Follow `nextCursor` through multiple pages and verify stable descending timestamp/ID order without duplicates or omissions.
- [ ] Submit a malformed or forged cursor; verify `VALIDATION_ERROR` with no data leak.
- [ ] Verify spelling correction preserves RSVP state/revision while prior history keeps its member/group display snapshots.

## Responsive and accessibility checks

- [ ] Use the same shared `RsvpForm` and draft/save logic at a desktop viewport in a modal.
- [ ] Use the same implementation at a mobile viewport as full-screen, with no horizontal overflow.
- [ ] Verify keyboard focus enters the modal, remains usable, and returns appropriately after close.
- [ ] Verify labels, select controls, disabled states, `role="alert"`, `role="status"`, and deadline/conflict feedback are accessible.
- [ ] Verify loading, unavailable API, invalid session, deadline read-only, conflict, inactive, success, no-op, and network failure states are honest.
- [ ] Verify local choices survive a conflict refresh and are not silently replaced by remote values.
- [ ] Inspect browser console, failed network requests, response headers, and absence of credentials/tokens in URLs, cookies, HTML, and client logs.

## Static build and privacy

- [ ] Build the public demo with API, database, and SMS provider unavailable.
- [ ] Verify the demo imports shared RSVP behavior through public package exports and contains no deep `src` import or copied RSVP implementation.
- [ ] Scan generated HTML/assets/serialized data for family names, member states, group IDs, responses, sessions, tokens, phones, PINs, credentials, and operational fixtures.
- [ ] Verify RSVP runtime loading/indisponibility does not prevent static editorial rendering.
- [ ] Keep QA screenshots, browser state, and operational fixtures outside committed public artifacts.

## Cleanup and evidence

- [ ] Save screenshots, console/network notes, and exact commands outside the repository or in an approved evidence location without secrets or PII.
- [ ] Record failures, fixes, and rerun results; a checklist item passes only after its affected path is rerun.
- [ ] Remove only fixtures and sessions created by this task from the disposable target. Preserve sentinel and pre-existing data.
- [ ] Run `git diff --check` after final documentation/source changes.
- [ ] Ask the primary agent to update `docs/block4Validation.md` with exact test, migration, artifact, and QA results.

## Listening

The checklist keeps browser QA independent from implementation work because conflicts, deadline edges, and no-false-success behavior require a separate black-box observer. It treats desktop and mobile as two presentations of one shared implementation, and it tests static privacy independently from runtime RSVP because a build can succeed while leaking operational data into artifacts. Fixtures are tenant-paired with a sentinel wedding so route-ID substitution and cleanup mistakes are observable.
