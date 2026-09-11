# Block 2 boundary for Block 3

Block 3 adds guest groups, OTP, guest sessions, and abuse controls. It must not
reuse an administrative session or the public recognition token as guest
identity. The previous transport experiment tested cookie isolation only; no
guest verification or authorization implementation is delivered in Block 2.

## Existing boundaries

- `packages/contracts/src/index.ts` defines strict site, administrative access,
  lifecycle, domain, session, and handoff payloads.
- `packages/database/src/schema.ts` owns administrative users/sessions,
  one-wedding memberships, sites, terms, domains, origins, and hashed manual
  access tokens. Apply reviewed migrations through the guarded database CLI.
- `apps/api/src/authHttp.ts` resolves the active administrative actor. OWNER is
  global; SITE_ADMIN requires the database membership for every scoped action.
- `apps/api/src/sitesHttp.ts` exposes owner business mutations and scoped reads.
  Business provisioning uses API operations with a stable provisioning key and
  repository slug; it must not become a script-to-database write path.
- `apps/admin/src/routes/api.$.ts` forwards to the fixed API origin. Workers
  contains no database connection or business authorization authority.
- `packages/wedding-features/src/AdminRecognition.tsx` holds only cosmetic,
  short-lived site recognition. The administrative cookie stays first-party in
  the central panel. A visitor opening a static site is not signed in.

## Constraints to preserve

Administrative activation and recovery are manual, one-use, 24-hour links.
There is no public administrative signup or automatic email. Password changes
require explicit login; recovery/disable revoke all account sessions, while
logout revokes only the current session. Administrative sessions use a 24-hour
idle and 7-day absolute limit. Recognition polling never refreshes activity.

A SITE_ADMIN cannot enumerate or act on another wedding. Guest APIs must enforce
their own wedding/group binding and the inactive wedding's read-only policy.
Deactivation keeps all operational rows. Terms and expiry do not automatically
deactivate or delete a site. Neutral static publication remains a manual action
covering every custom hostname and `workers.dev`.

Run `bun run check` and `bun run test:db` before integrating the next block.
The database suite selects only `DATABASE_URL_TEST` and verifies the actual Neon
branch. Keep development and production identities separate. Current browser
acceptance and any device-specific pending item are recorded in
`block2Validation.md`; do not turn Chrome viewport evidence into a Safari claim.
