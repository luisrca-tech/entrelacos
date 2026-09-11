# Block 3 guest identity contracts

Status: implemented and validated locally on 2026-09-11. Live Twilio delivery remains an explicit external gate.

## Group model

- A group belongs to one site, has a required name, one or more named members, and exactly one representative.
- An individual invitation is a normal one-member group. No parallel identity model exists.
- Brazilian groups require one normalized mobile number in E.164 form. The number is unique inside a site and may be reused by another site.
- Foreign groups have no phone or guest authentication path. They remain administrative records and the UI permanently explains that there is no SMS or alternative authentication.
- OWNER may operate every site. SITE_ADMIN may operate only the assigned site. Inactive sites allow group reads but reject group mutations.
- Changing the phone or representative atomically revokes active family sessions and pending challenges. Name and spelling corrections preserve them.

## Lookup and verification

Lookup accepts a full member name and Brazilian phone. Names are trimmed, internal whitespace is collapsed, accents are removed, and comparison is case-insensitive. Matching remains exact after normalization: incomplete, abbreviated, or approximate names do not match.

Challenges expire 10 minutes after their first send. Resend is unavailable for 60 seconds and never extends challenge expiry or resets wrong-attempt counters. Every send, including the first, is reserved atomically before provider dispatch.

| Scope | Limit | Window |
| --- | ---: | ---: |
| Site, group, and phone combination | 3 sends | 15 minutes |
| Site, group, and phone combination | 10 sends | 24 hours |
| Phone across sites | 3 sends | 15 minutes |
| Phone across sites | 10 sends | 24 hours |
| Client IP | 10 sends | 15 minutes |
| Client IP | 30 sends | 24 hours |
| Client IP verification attempts | 10 attempts | 15 minutes |
| Exact site and IP lookup | 10 attempts | 15 minutes |

Five declined codes lock the challenge and group/phone combination for 15 minutes. A provider `UNKNOWN` verification result does not consume a wrong-code attempt and is never retried automatically. A final send failure clears the local mock code and cannot be verified.

Provider send outcomes are `PROVIDER_ACCEPTED`, `FAILED_FINAL`, or `UNKNOWN`. Public delivery labels are `SIMULATED` and `REAL_SMS`; an unknown real result never claims that an SMS was sent.

## Family session

Successful verification creates an opaque bearer token. Only its SHA-256 hash is stored. The session is bound to one site and group, expires absolutely after seven days, and has no idle extension. The public client stores it only in site-namespaced `sessionStorage`, sends it in the `Authorization` header, and removes it after explicit leave or a server-side 401.

The static public site calls the API directly. Exact registered origins receive CORS headers; wildcard origins and credentialed cross-site cookies are not used. Public site IDs and route IDs are never authorization.

## Demo grant

Only an authenticated OWNER may issue a grant through `POST /v1/owner/sites/:siteId/demo/guest-grant`. Issuance requires an active demo-marked site, a Brazilian group phone present in the server allowlist, and exact admin origin. The HMAC-signed opaque grant is bound to the site and phone and expires after five minutes.

The panel displays the grant only in transient component state. The public demo accepts it only through `X-EntreLacos-Demo-Grant`; it is never accepted in a URL or cookie and is not persisted in browser storage. A valid grant permits disclosure of the deterministic simulation code. Missing, expired, mismatched, non-demo, non-owner, and non-allowlisted cases fail closed. Mock delivery is still labeled as simulation and is not evidence of SMS delivery.

## HTTP surface

| Method and path | Authorization | Result |
| --- | --- | --- |
| `GET /v1/sites/:siteId/groups` | OWNER or assigned SITE_ADMIN | Site-scoped group list |
| `POST /v1/sites/:siteId/groups` | OWNER or assigned SITE_ADMIN | Create group |
| `PATCH /v1/sites/:siteId/groups/:groupId` | OWNER or assigned SITE_ADMIN | Replace validated group composition |
| `DELETE /v1/sites/:siteId/groups/:groupId` | OWNER or assigned SITE_ADMIN | Delete group and owned identity records |
| `POST /v1/owner/sites/:siteId/demo/guest-grant` | OWNER only | Five-minute demo grant |
| `POST /v1/public/sites/:siteId/guest/challenge` | Exact public origin plus lookup data | Reserve and dispatch challenge |
| `POST /v1/public/guest/challenge/:challengeId/resend` | Challenge-bound exact origin | Reserve and dispatch resend |
| `POST /v1/public/guest/challenge/:challengeId/verify` | Challenge-bound exact origin | Create family session |
| `GET /v1/public/family/session` | Family bearer plus exact site origin | Read family members |
| `POST /v1/public/family/session/leave` | Family bearer plus exact site origin | Revoke current family session |

Every route uses strict JSON schemas and `application/problem+json` failures with stable machine codes. Public errors do not return group names, membership, phone values, hashes, provider credentials, or tokens.

## Twilio gate

The adapter targets Twilio Verify v2 `Verifications` and `VerificationCheck`. Real mode starts only when all server-side gates are present: explicit real-SMS authorization, valid Account and Verify Service SIDs, Auth Token, non-empty destination allowlist, confirmed Brazilian geo permission, and confirmed trial/usage constraints. Provider calls have a bounded timeout and occur outside database transactions; verification re-locks the challenge before creating a session.

No real SMS was sent during Block 3 implementation. The supplied operator phone and future credentials are not stored in source, fixtures, documentation, logs, or browser evidence.

## Listening

The design uses PostgreSQL constraints and transaction locks for tenant binding, representatives, reservations, and concurrency. Stateless HMAC grants were selected for the five-minute demo handoff because the grant needs no resettable long-lived state. A global phone throttle supplements site/group limits so distributing attempts across weddings cannot bypass abuse protection; tests use unique phone fingerprints and remove global rate-limit fixtures to remain repeatable.
