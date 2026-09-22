# Block 3 guest identity contracts

Status: manual group PIN redesign implemented on 2026-09-12. Live Twilio delivery remains an explicit external gate.

## Group model

- A group belongs to one site, has a required name, one or more named members, and exactly one representative.
- An individual invitation is a normal one-member group. No parallel identity model exists.
- `isIndividual` is set at creation and is immutable. Individual records always have exactly one member and cannot be converted into a multi-member group. A one-member family group remains a group and can still receive more members.
- Brazilian groups require one normalized mobile number in E.164 form. The number is unique inside a site and may be reused by another site.
- Foreign groups have no phone or guest authentication path. They remain administrative records and the UI permanently explains that there is no SMS or alternative authentication.
- OWNER may operate every site. SITE_ADMIN may operate only the assigned site. Inactive sites allow group reads but reject group mutations.
- Changing the phone or representative atomically revokes active family sessions and pending challenges. Name and spelling corrections preserve them.
- Every Brazilian group receives a random server-side seed at creation. The six-digit access PIN is derived with a domain-separated HMAC, is never stored in plaintext, and is returned only by an explicit authenticated, no-store reveal or rotation request.
- Rotating a PIN replaces its seed and atomically revokes active family sessions and pending challenges. The old PIN stops working immediately. PINs remain valid until rotation; only the verification challenge is time-limited.

## Lookup and verification

Lookup accepts a full member name and Brazilian phone. Names are trimmed, internal whitespace is collapsed, accents are removed, and comparison is case-insensitive. Matching remains exact after normalization: incomplete, abbreviated, or approximate names do not match.

Manual PIN is the MVP default (`SMS_MODE=manual`). Exact name and phone lookup creates a 10-minute `MANUAL` challenge without contacting a provider or creating a send record. Guests enter the PIN that the bride or planner shared out of band. Manual challenges cannot be resent; the guest restarts exact lookup after expiry.

SMS challenges retain their 10-minute lifetime. Resend is unavailable for 60 seconds and never extends challenge expiry or resets wrong-attempt counters. Every SMS send, including the first, is reserved atomically before provider dispatch.

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

Manual challenges use send status `MANUAL` and delivery label `MANUAL_PIN`. Provider send outcomes remain `PROVIDER_ACCEPTED`, `FAILED_FINAL`, or `UNKNOWN`, with `SIMULATED` and `REAL_SMS` delivery labels. An unknown real result never claims that an SMS was sent.

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
| `GET /v1/sites/:siteId/groups/:groupId/access-pin` | OWNER or assigned SITE_ADMIN | Transiently reveal the current PIN |
| `POST /v1/sites/:siteId/groups/:groupId/access-pin/rotate` | OWNER or assigned SITE_ADMIN | Rotate PIN and revoke active group access |
| `POST /v1/owner/sites/:siteId/demo/guest-grant` | OWNER only | Five-minute demo grant |
| `POST /v1/public/sites/:siteId/guest/challenge` | Exact public origin plus lookup data | Create a manual challenge or reserve an SMS challenge, according to server mode |
| `POST /v1/public/guest/challenge/:challengeId/resend` | Challenge-bound exact origin | Reserve and dispatch SMS resend; reject manual challenges |
| `POST /v1/public/guest/challenge/:challengeId/verify` | Challenge-bound exact origin | Create family session |
| `GET /v1/public/family/session` | Family bearer plus exact site origin | Read family members |
| `POST /v1/public/family/session/leave` | Family bearer plus exact site origin | Revoke current family session |

Every route uses strict JSON schemas and `application/problem+json` failures with stable machine codes. Public errors do not return group names, membership, phone values, hashes, provider credentials, or tokens.

## Twilio gate

The adapter targets Twilio Verify v2 `Verifications` and `VerificationCheck`. `SMS_MODE=real` starts only when all server-side gates are present: explicit real-SMS authorization, valid Account and Verify Service SIDs, Auth Token, non-empty destination allowlist, confirmed Brazilian geo permission, and confirmed account usage constraints. Provider calls have a bounded timeout and occur outside database transactions; verification re-locks the challenge before creating a session. There is no automatic fallback from an uncertain real send to manual PIN.

No real SMS was sent during Block 3 implementation. The supplied operator phone and future credentials are not stored in source, fixtures, documentation, logs, or browser evidence.

## Listening

The manual PIN is derived from a random per-group seed and the existing server guest HMAC secret. Plaintext storage and a plain six-digit hash were rejected because a database-only leak could brute-force the small PIN space. Rotation is the explicit invalidation mechanism; server-secret rotation deliberately changes every derived PIN. WhatsApp or another communication channel remains outside the product integration—the panel only supports copying the PIN.
