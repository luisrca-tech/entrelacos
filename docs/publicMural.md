# Public message mural

Decision: 2026-09-24. This replaces only the message rules in the earlier Block 5 and Block 7 contracts. RSVP, invitation access, and PIN verification retain their separate authorization rules.

## Visitor behavior

- An active site's enabled mural accepts a name and plain-text message from any visitor to its registered public origin. The name is a self-declared signature, not a verified guest identity. Equal names, including case and accent variants, are valid and are never matched to invitation guests.
- Every accepted submission creates a separate message. Visitors cannot edit or delete messages. The public read exposes only the message ID, signature, text, and creation time; the static wedding build contains no messages.
- The site switch stops new submissions when disabled, while previously published messages remain visible and paginated. The public composer is hidden and the page explains that new posts are paused. An inactive site stops public operations. Administrators assigned to the site, and the OWNER, can list and remove individual messages; they cannot edit text.

## API and abuse controls

- The public site-scoped mural read retains cursor pagination and the `enabled` field. The public create request carries a UUID request ID, author name, and message text. An identical retry returns the existing message; a reused ID with different content fails; a retry after administrative removal cannot republish the removed message.
- The API rejects oversized bodies and malformed values before publishing. It applies a bounded in-process request limit of 30 calls per minute per trusted client IP and a persistent quota of five accepted messages per hour per site and client IP. Rejections return `429` with `Retry-After`. Raw IPs and message contents are excluded from rate-limit records and operational logs.
- Registered-origin CORS protects browser access but does not authenticate a visitor. Application limits reduce ordinary abuse; they do not absorb volumetric traffic before it reaches Railway. Edge protection is a separate infrastructure decision.
- The admin message list filters by the visitor's declared name on the server, using the invitation search's case- and accent-insensitive substring behavior. Pagination applies to the filtered result. The search does not establish guest identity.

## Data and demo

- The new message record belongs to a site, not an invitation. The migration stops if legacy invitation messages are still present. Identify the database environment and confirm those rows were intentionally removed before applying it; do not allow a default production URL to stand in for the disposable test database.
- The demo reset's `block7-demo-v2` dataset starts with zero messages. Ordinary provisioning does not reset the demo merely because a visitor added a message. An explicit reset removes demo messages and rate/idempotency records within its existing site-scoped transaction.
- This changes both the public `/v1` message read DTO and write contract. Before any deployment, verify that no customer site is published and inventory the demo deployments. Pause public message traffic and drain in-flight requests, apply the reviewed migration to each explicitly selected environment, deploy the matching API and admin/public clients, invalidate any cached old static client, then reopen the mural. The old API cannot use the new tables, and an old public client cannot parse the new GET response. No migration or deployment is automatic.

## Acceptance

Exercise equal signatures, accents, concurrent independent posts, retry, deletion, a retry after deletion, pagination, foreign-site administration, disabled and inactive states, name search across pages, invalid origins, request limits, publication quota, and repeat demo provisioning with a visitor-created message. Confirm that disabling blocks new posts while existing messages stay visible. Verify migration and database tests only against the explicitly identified disposable test resource.
