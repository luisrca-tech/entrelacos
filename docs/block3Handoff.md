# Block 3 boundary for Block 4

Block 4 may build RSVP on the verified family identity delivered here. It must derive every guest operation from the family session's site and group, never from a submitted site, group, or member ID alone.

## Available boundaries

- `packages/contracts/src/index.ts` defines strict group, lookup, challenge, demo grant, and family-session payloads.
- `packages/database/src/schema.ts` owns site-scoped groups/members, challenge/send reservations, rate-limit events, and hashed family sessions.
- `apps/api/src/guestGroups.ts` owns administrative group mutations and revocation triggers.
- `apps/api/src/guestLookup.ts` owns exact normalized location and lookup throttling.
- `apps/api/src/guestVerification.ts` owns send/verify throttling, provider outcomes, challenge state, and session creation.
- `apps/api/src/familySession.ts` resolves and revokes family sessions.
- `apps/api/src/publicGuestHttp.ts` enforces registered origins and bearer transport for the static public site.
- `packages/wedding-features/src/GuestAccessPanel.tsx` restores only a site-namespaced browser-tab session and exposes the verified member list.

## Constraints to preserve

RSVP mutations must verify that every submitted member belongs to the family session's exact site/group. The representative is the group authority; other members do not receive independent accounts or tokens. A route ID, public site ID, administrative recognition, or demo grant never substitutes for a family session.

Keep the seven-day absolute session expiry and immediate server-side revocation. Phone/representative changes already revoke sessions and pending challenges; spelling-only edits preserve them. Inactive sites reject public operations while retaining data. Explicit leave must remain usable even if the site becomes inactive so the server-side token can still be revoked.

The demo grant authorizes only disclosure of the local simulation code for a marked demo phone and site. It grants no RSVP permission. Block 4 must require the resulting family bearer like any other guest flow.

Use `DATABASE_URL_TEST` exclusively for integration tests and preserve the guarded identity check. Apply migrations to development separately; do not connect to or migrate production. Run `bun run check` and `bun run test:db` before integration.

## Deferred boundaries

- RSVP state, deadlines, revisions, conflict handling, and history belong to Block 4.
- Messages, monthly SMS quotas, alerts, reports, exports, demo reset, and observability belong to later blocks.
- Live Twilio delivery remains pending explicit credentials, permission checks, country/trial/usage confirmation, allowlisted destination, and a separate authorization to send.

## Listening

Block 3 deliberately returns verified member identity without RSVP fields. This keeps the authentication slice stable and prevents Block 4 state or conflict semantics from leaking into the security boundary.
