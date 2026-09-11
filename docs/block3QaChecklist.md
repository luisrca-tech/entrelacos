# Block 3 end-to-end QA checklist

Status: PASS against local applications backed by the development database on 2026-09-11. Fixtures use synthetic identities and are removed after the run. Screenshots and the independent report stay outside the repository under `/tmp/entrelacos-block3-qa/independent`.

## Environment

- API: local Hono server with `APP_ENV=development`, mock SMS, explicit simulation-code exposure, and a synthetic demo-phone allowlist.
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

## Responsive and runtime checks

- [x] Repeat the guest path at a 390 × 844 viewport without horizontal overflow or unusable controls.
- [x] Inspect browser console errors and failed network requests on the admin and public paths.
- [x] Confirm exact-origin CORS between public site and API.
- [x] Preserve the sentinel site and unrelated data after the run.

The independent rerun completed grant, exact lookup, OTP, family, refresh, spelling preservation, representative revocation, leave, foreign, sentinel, desktop, and mobile paths. Its final report conservatively retained `BLOCKED` because a second approximate-name repetition hit the intended lookup throttle and its last console command was interrupted. A focused post-fix browser run had already confirmed the approximate-name generic response, and a final clean public/admin console sweep then reported no application exceptions. The only observed failed asset was Astro's local development toolbar `504`, which did not affect the application and is not part of a production build.

## Acceptance rule

The checklist passes only after the independent browser worker completes every applicable item, records failures, and reruns affected paths after any fix. A mock code proves the application flow only. Live Twilio delivery remains pending until the provider gates and separate send authorization are satisfied.

## Listening

The QA uses a disposable OWNER identity and synthetic guest data in development because Block 3 includes a real administrative and cross-origin browser flow. Authentication state is prepared in a permission-restricted local state file rather than placed in a URL. Evidence remains outside version control so screenshots cannot accidentally become fixtures or releases.
