# Block 3 end-to-end QA checklist

Status: PASS. The original Block 3 flow passed on 2026-09-11; the manual group PIN redesign received a focused clean-browser rerun on 2026-09-12. Fixtures use synthetic identities and are removed after each run. Current manual-PIN evidence stays outside the repository under `/tmp/entrelacos-manual-pin-qa/`.

## Environment

- API: local Hono server with `APP_ENV=development`. The focused redesign run used `SMS_MODE=manual`; the earlier demo run used explicit mock SMS and simulation-code exposure.
- Admin: local TanStack Start server on an isolated QA origin, authenticated through a disposable OWNER account.
- Public site: local Astro demo on a distinct origin, configured with the disposable demo site ID.
- Database: `DATABASE_URL` development connection after reviewed Block 3 migrations. Automated integration tests use only `DATABASE_URL_TEST`.
- Isolation: one active demo site and one sentinel non-demo site. No production connection, Twilio credential, or real SMS is used.

## Administrative flow

- [x] Open the authenticated panel and select the demo site.
- [x] Create a Brazilian group with two members and exactly one representative.
- [x] Reject missing fields, an invalid Brazilian phone, and an invalid representative selection.
- [x] Reload and confirm group persistence.
- [x] Create and delete a one-member individual invitation.
- [x] Create a foreign-number group and retain the administrative-only explanation.
- [x] Confirm the non-demo sentinel does not expose demo-grant issuance.
- [x] Issue a transient demo grant for the allowlisted Brazilian group without placing it in a URL or browser storage.
- [x] Reveal and copy a six-digit group PIN through authenticated, no-store administration.
- [x] Rotate the PIN, display the replacement, and revoke the previous PIN plus the active family session.

## Public guest flow

- [x] Reject approximate or incomplete names and accept the exact normalized full name despite case, accents, or whitespace differences.
- [x] Start a simulated challenge and show the 60-second resend countdown with an explicit simulation label.
- [x] Reject one wrong six-digit code without exposing group data.
- [x] Accept the valid simulated code and show every family member.
- [x] Refresh the same browser tab and restore the family session from site-namespaced `sessionStorage`.
- [x] Confirm no family token or demo grant appears in the URL or cookies.
- [x] Preserve the active session after a spelling-only administrative edit.
- [x] Revoke the active session after a representative or phone change.
- [x] Complete a new flow, explicitly leave, and prove the bearer is rejected afterward.
- [x] Show the permanent foreign-number administrative-contact explanation.
- [x] Start a manual challenge without a demo grant or provider send, show manual-PIN guidance, and omit the resend control.
- [x] Reject a wrong and a rotated-out PIN without exposing group data; accept the current PIN and render the family.

## Responsive and runtime checks

- [x] Repeat the guest path at a 390 × 844 viewport without horizontal overflow or unusable controls.
- [x] Inspect browser console errors and failed network requests on the admin and public paths.
- [x] Confirm exact-origin CORS between public site and API.
- [x] Preserve the sentinel site and unrelated data after the run.

The 2026-09-12 focused rerun completed group creation, PIN reveal/copy, manual lookup, no-resend presentation, wrong/current PIN handling, session creation, PIN rotation, session revocation, old-PIN rejection, replacement-PIN acceptance, desktop/mobile overflow checks, and console review. It found and corrected stale “code” labels plus a misplaced error branch, then reran the affected path successfully. Screenshots and the concise report are in `/tmp/entrelacos-manual-pin-qa/`. No application console exception remained.

## Acceptance rule

The checklist passes only after every applicable item is completed, failures are recorded, and affected paths are rerun after correction. Manual PIN success proves the provider-free MVP flow. A mock code proves only simulation. Live Twilio delivery remains pending until the provider gates and separate send authorization are satisfied.

## Listening

The QA uses a disposable OWNER identity and synthetic guest data in development because Block 3 includes a real administrative and cross-origin browser flow. Authentication state is prepared in a permission-restricted local state file rather than placed in a URL. Evidence remains outside version control so screenshots cannot accidentally become fixtures or releases.
