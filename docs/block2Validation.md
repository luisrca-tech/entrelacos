# Block 2 implementation and validation

Status: in progress. This record is not acceptance of Block 2.

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

## Outstanding gates

The initial database/authentication foundation passed its bounded checks below. The cross-site browser experiment, activation/recovery, complete session/tenancy enforcement, lifecycle, panel integration, public integration, and final QA remain outstanding. The normal application entry points still expose scaffold behavior until the integration waves are accepted.

## Foundation evidence

- Nine focused database-guard tests pass, including missing test URL, shared branch, unsupported target, and malformed-URL redaction cases. The last three were observed failing before their guards were added.
- The dedicated database identity test passed against the actual testing branch, without a mock or conditional skip.
- `0000_admin_auth_foundation.sql` was reviewed and applied only to testing. A second migration run completed without reapplying the SQL.
- Eight Better Auth/bootstrap unit tests and four real PostgreSQL tests passed. They cover disabled signup, active login, refusal of pending/disabled accounts, library password hashing, and preservation of an existing OWNER password.
- API and database typechecks passed at the foundation boundary. This does not imply final integration acceptance.

## Browser experiment preparation

The isolated local HTTPS topology uses `panel-entrelacos.test`, `api-entrelacos.test`, and `demo-entrelacos.test` on port 18443, forwarding to dedicated test processes on 13000, 18080, and 14321. The existing development processes on the approved standard ports are preserved. The browser trusts only the generated local certificate's public-key fingerprint for this experiment; no browser same-origin or cookie protections are disabled.

A cookie control passed in Chrome for Testing 149: a Secure/HttpOnly/SameSite=None cookie was sent on the API's first-party visit, but was absent from the demo's cross-site request even with credentials included. Both pages reported a secure context. Evidence is retained under ignored `work/block-2/`.

The isolated browser integration passed in Chrome for Testing 149 using the real testing database and the implemented auth router, BFF proxy, and handoff service:

- Credential login returned the sanitized success response; refreshing the panel preserved the first-party session.
- Opening the site completed the challenge-bound handoff across three distinct HTTPS sites. The return fragment was removed and site storage contained only the short-lived recognition credential.
- Panel logout caused the site to discard its recognition credential and hide the Panel link. This also passed with the panel in a separate tab.
- The independent guest transport proof continued to work after administrative logout. It is a transport experiment only, not implemented guest authentication.
- A 390-by-844 viewport repeated recognition and revocation. This is desktop Chromium viewport emulation, not a mobile-browser result.
- Visual inspection found a prototype CSS rule overriding the hidden attribute. The prototype was corrected and the final browser check verified that the revoked Panel link had no rendered rectangle.

Screenshots are retained locally in ignored `work/block-2/desktop-recognition.png`, `work/block-2/mobile-viewport-recognition.png`, and `work/block-2/mobile-viewport-revoked.png`. The dedicated browser and test servers were stopped after the experiment. Cleanup removed only the experiment's identified user and two site-bound transport records; the existing development servers were preserved.

The experiment used minimal HTML surfaces and a Node-hosted BFF harness. It does not prove the final TanStack/Workers integration, which remains required. The harness is ignored local material and is not imported by application entry points or builds.

## Current combined checks

On 2026-09-11, `bun run check` passed: lint, seven typecheck tasks, 49 unit tests across six files, and three builds. Unchanged package tasks reused the verified baseline cache. `bun run test:db` separately passed ten real PostgreSQL integration tests across four files, with serialized database access. The tests cover session boundaries, concurrent one-use handoff consumption, invalid bindings before valid consumption, token expiry, and parent-session revocation. These results validate the current foundation and experiment, not the remaining product scope.

## Blocking evidence and resume point

T2 remains pending actual mobile-browser evidence. The accepted playbook states that viewport emulation does not substitute for mobile cookie-policy evidence, and T3 depends on acceptance of T2. No actual mobile browser is connected; the device-availability question remains unanswered. Do not silently mark this gate green or transfer it to Block 3.

Resume by identifying the available Android/Chrome or iPhone/Safari device and establishing three reachable HTTPS sites trusted by that device. The current desktop-only hostname mapping and certificate fingerprint exception do not automatically configure a phone. Repeat the first-party versus blocked third-party cookie control, login/refresh, handoff/return, and logout revocation on that browser, recording browser/OS versions and sanitized results. Production is outside this experiment.

After T2 acceptance, continue T3 contracts/schema, T4 activation and recovery, T5/T6 lifecycle API and auth UI, T7 operational panel, T8 static-site integration, T9 full QA, and T10 development migration/bootstrap and Block 3 handoff. None of those remaining tasks is claimed complete.

## Listening

The implementation follows the accepted orchestration playbook. Database identity checks use the server-reported Neon branch identity rather than treating different hostnames or a resource called testing as proof of isolation. Production remains outside the authorized scope. Product acceptance will be recorded only after the corresponding integration and browser gates pass.
