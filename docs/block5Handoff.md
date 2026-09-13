# Block 5 handoff

Status: Block 5 implementation and its authorized local validation are complete on `block-5/messages-exports-sms`. The branch contains the frozen contracts, migration, API, admin, shared wedding feature, demo integration, and test coverage. Executed evidence is recorded in `docs/block5Validation.md`.

## Delivered boundary

Block 5 supplies one revision-protected message per guest group, a runtime-only public mural, administrator moderation, exact-confirmation group deletion, wedding-scoped RSVP exports, and site-level monthly SMS accounting. The API and database remain authoritative for identity, tenant scope, lifecycle, moderation, conflicts, deletions, export snapshots, and quota reservations.

The manual six-digit group PIN remains the MVP access path and does not consume SMS quota. A missing monthly limit blocks new real SMS reservations. Simulation has its own counter and label and cannot satisfy a provider gate.

## Public feature exports

The public `packages/wedding-features/src/index.ts` entrypoint now adds:

- `FamilyMessageForm` and `FamilyMessageFormProps` for the authenticated group's current message;
- `MessageMural`, `MessageMuralProps`, and `mergeMuralMessages` for runtime public rendering and pagination;
- `WeddingMessagesApi`, `WeddingMessagesApiError`, and `WeddingMessagesApiOptions` for the existing family/public transport boundary;
- `countMessageCodePoints`, `getMessageErrorMessage`, and `muralRefreshEventName` for shared validation and refresh behavior.

`GuestAccess` composes the family editor after the existing session and RSVP load. The wedding demo renders `MessageMural` as a hydrated runtime component. A host must import these symbols only through the public package entrypoint and must supply `PUBLIC_API_URL` and the environment-local `PUBLIC_SITE_ID`; it must not embed mural rows, family state, PINs, phones, sessions, or RSVP data in static content.

## API integration points

Public family and mural consumers use:

- `GET /v1/public/family/message` and `PUT /v1/public/family/message` with the validated family bearer and exact registered site origin;
- `GET /v1/public/sites/:siteId/mural` without a bearer but with the exact registered public origin.

The family write includes normalized text, expected revision, and a UUID request ID. Preserve `MESSAGE_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `MURAL_DISABLED`, `MESSAGE_BLOCKED`, `SESSION_INVALID`, and lifecycle errors. Public mural rows contain only message ID, author and group display snapshots, text, and creation/update timestamps. Load mural data at runtime with `no-store`; never serialize it into the Astro build.

Administrative consumers use:

- `GET /v1/sites/:siteId/messages`;
- `GET/PATCH /v1/sites/:siteId/mural`;
- `DELETE /v1/sites/:siteId/groups/:groupId/message`;
- `PATCH /v1/sites/:siteId/groups/:groupId/message-block`;
- `DELETE /v1/sites/:siteId/groups/:groupId`;
- `GET /v1/sites/:siteId/reports/rsvp.csv` and `.pdf`;
- `GET /v1/sites/:siteId/sms-usage`;
- `PATCH /v1/owner/sites/:siteId/sms-quota` for OWNER only.

Group deletion requires the exact current group ID and name in the JSON body. It removes group-owned members, RSVP/history, messages, sessions, and pending challenges in one transaction, redacts replayable RSVP receipts through their group links, and retains site-level SMS accounting. A stale family editor cannot restore deleted data.

Reports are read-only repeatable snapshots and exclude messages, history, internal IDs, sessions, receipts, and quota data. CSV is UTF-8 with BOM and CRLF and protects spreadsheet-formula prefixes. PDF is local A4 output using pinned PDFKit and DejaVu dependencies. Phone inclusion is explicit and limited to each group's representative.

## Block 6 boundary

Block 6 may style and place `FamilyMessageForm` and `MessageMural` through the public feature seam. It must preserve:

- one shared message controller and the server revision/idempotency protocol;
- exact-origin runtime mural reads and public-field privacy;
- server-owned mural and block decisions;
- message independence from RSVP and SMS state;
- no operational records in static HTML, JavaScript state, SEO, content contracts, or fixture data;
- no deep imports from package `src` paths or imports from the API, admin, or database packages.

Presentation may change labels, layout, theme, and placement. It cannot add a typed author, expose group members, edit guest text administratively, change the 1,000-code-point rule, or turn mural content into build-time data.

## Remaining release gates

- Apply migration `0007_windy_sage.sql` to development only after a separate migration review and authorization; production remains a later explicit operation.
- Resolve the pre-existing OWNER site-list and SITE_ADMIN activation browser limitations before broad release acceptance.
- Complete privacy, retention, deletion-exception, backup/restore, infrastructure, domain, monitoring, and final design approvals.
- Keep real SMS disabled unless the OWNER limit and every provider/account authorization gate are explicitly satisfied and separately tested.

No commit, push, deployment, provider call, or production mutation is part of this handoff.

## Listening

Block 5 keeps presentation reusable while retaining all operational authority in the API. Runtime mural reads were selected because static publication would leak mutable guest content into artifacts and delay moderation. Site-level SMS accounting survives group deletion because provider cost belongs to the wedding period, while group-owned sessions, messages, and replayable RSVP data must be removed or redacted with the group.
