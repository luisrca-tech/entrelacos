# Block 5 messages, exports, and SMS usage contracts

Status: approved for implementation on 2026-09-12. This document freezes the Block 5 local implementation boundary. Production migration, deployment, live Twilio delivery, and legal retention approval remain separate gates.

## Existing invariants

- The family bearer from Block 3 is the only public identity proof. The API derives the site, group, representative, and author identity from that session.
- Public clients do not submit an author, site, group, phone, member list, or RSVP state as message authority.
- The API and PostgreSQL own authorization, tenant isolation, moderation, deletion, reporting, and SMS accounting.
- Message controls and SMS quota never invalidate an existing family session or block public or administrative RSVP.
- An inactive site blocks public operations and Block 5 mutations. Authorized administrative report reads remain available.
- All operational responses use `Cache-Control: no-store`. Errors use `application/problem+json` with stable machine codes and no private tenant data.
- Static wedding builds require no API, database, or SMS provider. Messages and guest records remain runtime data and never become editorial content or generated HTML.

## Message content and identity

Each group has at most one current message. The message is plain text with one through 1,000 Unicode code points after CRLF and CR are normalized to LF. Newlines and emojis are accepted. Blank text, angle brackets, prohibited control characters, HTML, multipart bodies, attachments, and extra JSON fields are rejected.

The stored author name and group name are snapshots taken from the registered representative and group when a message is created. Editing changes the text and update time but preserves those original attribution snapshots. A later representative may edit the group's current message through a valid family session. If moderation deletes the message, a later publication creates fresh attribution snapshots.

The family read returns the current message, the group's durable current revision, and whether editing is allowed. `MURAL_DISABLED` and `MESSAGE_BLOCKED` are read-only reasons. Invalid, expired, or revoked sessions and inactive sites remain request errors rather than editable family state.

## Message mutation, concurrency, and idempotency

`PUT /v1/public/family/message` accepts:

```json
{
  "requestId": "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5",
  "expectedRevision": 0,
  "text": "Viva os noivos!\nCom carinho."
}
```

- Revision zero creates the first message when the group's durable revision is zero.
- A matching later revision edits or republishes the current message.
- A successful mutation increments the durable group revision and returns `APPLIED`.
- Identical text with the current revision returns `NO_CHANGE` without changing timestamps or revision.
- A stale revision returns `409 MESSAGE_CONFLICT` and the current revision without exposing message data outside the authenticated group.
- The API serializes mutations for a group. Concurrent writes from the same revision result in one success and one conflict.
- `requestId` is scoped by site, group, family session, and request kind. An identical replay returns the stored result with `replayed: true`. Reusing the ID with another payload returns `409 IDEMPOTENCY_KEY_REUSED`.
- Authentication, session validity, site activity, mural state, and group block are evaluated before returning a replay.
- Administrative deletion increments the durable revision and marks affected receipts removed. A later retry of a removed result returns `410 MESSAGE_REMOVED`; it cannot recreate or return deleted text.

## Public mural and moderation

`GET /v1/public/sites/:siteId/mural` is an unauthenticated runtime read restricted to the requested site's public origin. The response exposes only message ID, stored author name, stored group name, text, created time, and updated time. It never includes phone numbers, member lists, RSVP, session, revision, block state, or administrative data.

Rows are ordered by `createdAt DESC, id DESC`. The opaque cursor represents that pair, is bound to the requested site, and must be used only as returned. The default page size is 20 and the maximum is 100. Editing does not reorder a message. A disabled mural returns `enabled: false`, no messages, and no cursor. Stored messages remain intact.

The shared mural controller refreshes on mount, when the document becomes visible, after an action performed in that client, and every 30 seconds while visible. A refresh restarts at the first page and replaces previously loaded pages so deleted messages do not remain in local state. Network failure reports unavailability and does not claim freshness. No instant update is promised for offline or background clients.

`OWNER` and assigned `SITE_ADMIN` may read message administration, toggle the mural, delete a message, and block or unblock message writes for a group. An administrator cannot edit guest text. Blocking preserves and continues to display an existing message; deletion is the explicit operation for removing it. Deletion allows a later publication if the site, mural, and group permit it.

## Destructive group deletion

`DELETE /v1/sites/:siteId/groups/:groupId` requires a strict JSON body:

```json
{
  "confirmGroupId": "group-id",
  "confirmGroupName": "Família Silva"
}
```

The API locks and compares both values with the target group inside the deletion transaction. A mismatch returns `409 GROUP_CONFIRMATION_MISMATCH`. A missing or already deleted group returns `404 GROUP_NOT_FOUND`. Authorization failure does not reveal whether the group exists.

One transaction removes the target group, members and current RSVP, RSVP history, message and message receipts, family sessions, pending or completed group challenges, send records, and group rate-limit events. Other groups and sites remain unchanged.

Administrative RSVP receipts may contain members from several groups and do not always carry a group ID. A receipt whose stored response contains a deleted member is redacted in the same transaction: its response body is removed, its removed time is recorded, and a later replay returns `410 RSVP_RESULT_REMOVED`. The request identity and hash remain only to prevent a deleted operation from being reapplied. Unaffected receipts remain replayable.

Site-level monthly SMS usage survives group deletion. A provider return that races with deletion may update only its durable site-level reservation and cannot recreate a group, challenge, session, or message. Legal retention and deletion exceptions remain a launch gate; this contract does not claim legal compliance.

## RSVP exports

Authorized `OWNER` and assigned `SITE_ADMIN` may export an active or inactive site. Both formats require a UUID `requestId`, an explicit `includePhone=true|false`, and accept optional existing `groupId` and RSVP `state` filters.

The report uses one consistent site-scoped read and contains:

- wedding heading, generation instant, display timezone, and selected filters;
- whole-site totals for `PENDING`, `CONFIRMED`, and `DECLINED`;
- selected-row totals for the same states;
- group name, member name, and current RSVP state;
- the representative phone only when explicitly included.

Messages, history, revisions, member/group IDs, PINs, sessions, receipts, and provider details are excluded. A foreign group has an empty representative phone when that column is requested. Rows are ordered by group name, group ID, member name, and member ID so equal names remain deterministic. A valid empty selection still produces the heading, generation data, filters, and zero selected totals.

The display timezone is `America/Sao_Paulo`; the generation instant remains UTC in machine-readable metadata.

### CSV

CSV is UTF-8 with a BOM, comma delimiter, CRLF records, and RFC 4180 quoting. It has a rectangular structure with one `SUMMARY` row followed by `MEMBER` rows. Fixed columns are `recordType`, `reportTitle`, `generatedAt`, `timezone`, `groupFilter`, `stateFilter`, `totalPending`, `totalConfirmed`, `totalDeclined`, `selectedPending`, `selectedConfirmed`, `selectedDeclined`, `groupName`, `memberName`, and `rsvpState`. `representativePhone` is present only when requested.

Every untrusted textual cell is protected from spreadsheet formula interpretation, including values beginning with `=`, `+`, `-`, `@`, tab, CR, or LF. Quoting alone is not treated as formula-injection protection.

The content type is `text/csv; charset=utf-8`.

### PDF

The PDF is an A4 portrait report with 15 mm margins, embedded local fonts, heading, filters, totals, repeated table headings, safe row continuation, and `page X / Y`. Unicode fixture names and long content must render without clipping or silent glyph replacement. Multiple pages are an acceptance requirement.

The implementation may add PDFKit only after a focused proof confirms local embedded-font Unicode, wrapping, table layout, and pagination. It must not download fonts or contact a rendering service at request time.

The content type is `application/pdf`.

Both exports use `Content-Disposition: attachment`, `Cache-Control: no-store`, and the safe name `entrelacos-rsvp-<safe-site-id>-<UTC>-<request-id>.<ext>`. Generation failure returns a structured problem response rather than a partial successful download. The admin proxy preserves binary bytes, content type, cache headers, and content disposition.

## Monthly SMS usage

Manual group PIN is the MVP verification path and does not create an SMS reservation. Live SMS is disabled unless the `OWNER` explicitly configures a nonnegative monthly limit and every existing real-provider gate is satisfied. No default numeric limit is inferred.

SMS accounting uses the civil month in `America/Sao_Paulo`, represented by a start-inclusive and end-exclusive UTC interval derived from the server clock. `SIMULATED` and `REAL_SMS` usage are stored and displayed separately. Simulated usage exercises quota behavior but is never presented as Twilio account usage, delivery, or cost.

Before each initial send or resend, the API atomically locks the site and accounting period, checks the configured limit, and reserves one unit. The reservation consumes quota whether its current result is `RESERVED`, `PROVIDER_ACCEPTED`, `FAILED_FINAL`, or `UNKNOWN`. Provider acceptance does not claim delivery. Failure and unknown results are not refunded automatically, and unknown results are never retried automatically. An abandoned reservation remains visible as reserved and consumed until an explicit future reconciliation contract exists.

Exactly one concurrent request can reserve the last available unit. A request at the ceiling receives `429 SMS_QUOTA_EXCEEDED` before a provider call, with guidance to contact the operator. A missing configuration receives `503 SMS_QUOTA_NOT_CONFIGURED`. Setting a lower limit than current consumption immediately blocks further reservations; raising it can allow later sends. Zero is a valid configured block.

The usage read shows period, timezone, configured limit, and counts for reserved, provider accepted, final failure, unknown, and consumed, separated by real and simulated modes. Alert state is `NOT_CONFIGURED`, `BELOW_80`, `AT_OR_ABOVE_80`, or `AT_OR_ABOVE_100`. Threshold comparison uses exact integers without premature percentage rounding.

Only `OWNER` may configure the limit. Reading is available to `OWNER` and the assigned `SITE_ADMIN`. Existing sessions, family/admin RSVP, saved RSVP, manual PIN, and non-SMS administration remain operational when SMS is unconfigured or exhausted.

## HTTP surface

| Method and path | Authorization | Purpose |
| --- | --- | --- |
| `GET /v1/public/family/message` | Family bearer and exact site origin | Read the current group message and edit state |
| `PUT /v1/public/family/message` | Family bearer and exact site origin | Create, edit, or republish with revision/idempotency |
| `GET /v1/public/sites/:siteId/mural` | Exact registered public origin | Read the runtime public mural |
| `GET /v1/sites/:siteId/messages` | Site-scoped admin | Read moderation state |
| `GET /v1/sites/:siteId/mural` | Site-scoped admin | Read mural configuration |
| `PATCH /v1/sites/:siteId/mural` | Site-scoped admin | Enable or disable the mural |
| `DELETE /v1/sites/:siteId/groups/:groupId/message` | Site-scoped admin | Delete the current message at an expected revision |
| `PATCH /v1/sites/:siteId/groups/:groupId/message-block` | Site-scoped admin | Block or unblock group message writes |
| `DELETE /v1/sites/:siteId/groups/:groupId` | Site-scoped admin | Confirm and delete a group transactionally |
| `GET /v1/sites/:siteId/reports/rsvp.csv` | Site-scoped admin | Download the CSV report |
| `GET /v1/sites/:siteId/reports/rsvp.pdf` | Site-scoped admin | Download the PDF report |
| `GET /v1/sites/:siteId/sms-usage` | Site-scoped admin | Read monthly configuration and usage |
| `PATCH /v1/owner/sites/:siteId/sms-quota` | OWNER only | Configure the monthly limit |

Stable Block 5 codes are `MURAL_DISABLED`, `MESSAGE_BLOCKED`, `MESSAGE_CONFLICT`, `MESSAGE_REMOVED`, `MESSAGE_NOT_FOUND`, `GROUP_CONFIRMATION_MISMATCH`, `RSVP_RESULT_REMOVED`, `SMS_QUOTA_NOT_CONFIGURED`, and `SMS_QUOTA_EXCEEDED`. Existing `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `SITE_INACTIVE`, `SESSION_INVALID`, `IDEMPOTENCY_KEY_REUSED`, and `SERVICE_UNAVAILABLE` boundaries remain in force.

## Package boundary

`packages/contracts` owns the strict serializable HTTP shapes. `packages/database` owns tables, constraints, migrations, and tenant-safe relations. `apps/api` owns authorization, isolation, ordering, mutation, moderation, deletion, report generation, and quota reservation. `apps/admin` owns operational controls and downloads. `packages/wedding-features` owns family message and mural transport/presentation using the existing session store. `apps/wedding-demo` is the runtime QA host. `packages/template-root` owns no Block 5 authority or operational data.

## Listening

The group revision survives message deletion so an already-open editor cannot recreate moderated text. RSVP receipts are redacted rather than silently cascaded because one administrative request may span several groups; retaining the request hash prevents accidental reapplication without retaining deleted response data. SMS quota is accounted at site level so deleting a group cannot refund provider capacity. The MVP remains provider-free through the existing manually shared group PIN, while the simulated path validates quota behavior without claiming real delivery or cost.
