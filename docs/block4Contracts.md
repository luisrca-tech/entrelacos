# Block 4 RSVP contracts

Status: Block 4 contracts are frozen and the authorized local implementation passed database, browser, static-privacy, and repository validation on the `block-4/member-rsvp` branch. Deployment and production migration remain outside this block.

## Scope and invariants

- RSVP is individual per member. The only states are `PENDING`, `CONFIRMED`, and `DECLINED`.
- The authenticated family representative answers for every member in the session's group. Members have no independent account or token.
- A family can submit a full response, a partial response, or an unchanged response. Members omitted from a request are untouched and do not participate in its conflict check.
- A draft, including “confirm all”, is local UI state. Viewing the form and changing a selection do not write to the API. Only an explicit save submits changes.
- A configured deadline is a server-side UTC instant paired with an explicit IANA timezone for display and operator input. No deadline is represented by `deadlineAt: null` and `deadlineTimezone: null`; the pair is never partially populated.
- When both deadline fields are `null`, no deadline blocks public RSVP writes; the existing valid family session and active-site rules still apply.
- Public reads remain available after the deadline. Public writes are rejected at the exact instant `serverNow >= deadlineAt`.
- Authorized `OWNER` and assigned `SITE_ADMIN` actors can record or correct responses after the deadline while the wedding is active. An inactive wedding allows operational reads but rejects RSVP and deadline mutations.
- Member revision is optimistic concurrency state. Every submitted member carries its expected revision. A stale member causes the whole request to roll back, including other submitted members and history rows.
- History records only real transitions. No-op writes and idempotent replays do not create a transition.
- `PENDING` survives the deadline, administrative corrections, and future export preparation. Silence never means `DECLINED`.

## Authorization and transport

The Hono/Node API is the authority for authorization, deadline evaluation, revision checks, persistence, and history. The public Astro site calls the API directly through `packages/wedding-features`, reusing the Block 3 bearer in site-namespaced `sessionStorage` and the `Authorization: Bearer <token>` header. The API derives site and group from the validated family session; it does not trust site, group, or member IDs supplied by the browser as authorization.

Public RSVP requests require both the current family bearer and an exact registered origin for that session's site. The session is seven-day absolute, server-revocable, and bound to one site and group. Expired, revoked, inactive, foreign-group, missing, or cross-site sessions fail closed. An origin or demo grant alone grants no RSVP permission. Administrative routes require the existing admin session, exact configured admin origin, and `OWNER` or site-assigned `SITE_ADMIN` scope.

All responses use `Cache-Control: no-store`. Public cross-origin responses use the registered origin in `Access-Control-Allow-Origin`; wildcard origins, credentialed cross-site cookies, and URL tokens are excluded. Errors use `application/problem+json` with a stable `code` and no private tenant data.

## HTTP surface

The implementation exports these route names from `block4EndpointPaths`:

| Method and path | Authorization | Purpose |
| --- | --- | --- |
| `GET /v1/public/family/rsvp` | Current family bearer and exact registered site origin | Read every member in the session group and server-evaluated edit state |
| `POST /v1/public/family/rsvp` | Current family bearer and exact registered site origin | Save submitted member states atomically |
| `GET /v1/sites/:siteId/rsvp` | Admin session, exact admin origin, site scope | Read current groups, members, states, revisions, totals, and optional filters |
| `POST /v1/sites/:siteId/rsvp` | Admin session, exact admin origin, site scope | Save one or more member states atomically, including post-deadline corrections while active |
| `GET /v1/sites/:siteId/rsvp/deadline` | Admin session, exact admin origin, site scope | Read the configured deadline pair |
| `PATCH /v1/sites/:siteId/rsvp/deadline` | Admin session, exact admin origin, site scope | Set or remove the deadline pair while the site is active |
| `GET /v1/sites/:siteId/rsvp/history` | Admin session, exact admin origin, site scope | Read a separate, filtered, cursor-paginated operational history |

The public read response is:

```json
{
  "siteId": "site-demo",
  "groupId": "group-demo",
  "deadlineAt": "2028-04-02T03:00:00.000Z",
  "deadlineTimezone": "America/Sao_Paulo",
  "serverNow": "2028-04-01T12:00:00.000Z",
  "canEdit": true,
  "readOnlyReason": null,
  "members": [
    {
      "id": "member-1",
      "fullName": "Ana Silva",
      "isRepresentative": true,
      "state": "PENDING",
      "revision": 0
    }
  ]
}
```

After the deadline, `canEdit` is `false` and `readOnlyReason` is `"DEADLINE_PASSED"`. `serverNow` is generated by the API clock. The client may use it for display, but it cannot decide authorization or deadline enforcement.

Both write routes accept the same strict JSON payload. The array has one to 500 unique members; `requestId` is a UUID.

```json
{
  "requestId": "2c7f8f3b-7d7d-4bd7-a21d-9d68ac3fb8b5",
  "members": [
    {
      "memberId": "member-1",
      "state": "CONFIRMED",
      "expectedRevision": 0
    }
  ]
}
```

The write response contains `requestId`, server `acceptedAt`, `result` (`APPLIED` or `NO_CHANGE`), `replayed`, and the resulting records for submitted members. An applied state change increments that member's revision by one. An unchanged state retains its revision.

The current admin read accepts optional `groupId` and `state` query parameters. Totals cover the entire selected site; returned groups and members reflect the filters. Group totals remain available for each returned group. The current admin presentation exposes current operations separately from history and provides status/group totals.

The deadline read and write use this strict body:

```json
{
  "deadlineAt": "2028-04-02T03:00:00.000Z",
  "deadlineTimezone": "America/Sao_Paulo"
}
```

To remove a deadline, send both fields as `null`. The admin UI accepts a local wall-clock value and IANA timezone, converts it to the UTC instant, and displays the selected timezone. A malformed, nonexistent, or invalid-timezone local value is rejected before save. A deadline may be set in the past; public state then becomes read-only according to the server clock.

## History contract

History is a separate administrative view. `GET /v1/sites/:siteId/rsvp/history` accepts:

| Query parameter | Contract |
| --- | --- |
| `cursor` | Opaque base64url cursor containing the prior page's `occurredAt` and `id`; use only the returned value |
| `limit` | Integer from 1 through 100; default 50 |
| `groupId` | Optional group filter |
| `memberId` | Optional member filter |
| `actorType` | Optional `FAMILY` or `ADMIN` filter |
| `beforeState` / `afterState` | Optional state transition filters |
| `from` / `to` | Optional ISO instants; `from` is inclusive and `to` is exclusive |

Rows are ordered by `occurredAt DESC, id DESC`. `nextCursor` is `null` when there is no next page. Every entry contains the site, group, member, `beforeState`, `afterState`, `actorType`, `actorId`, `actorDisplayName`, and `occurredAt`. Group and member display names are stored as transition snapshots so the audit entry remains readable after spelling corrections.

The actor representation is fixed:

- `FAMILY`: `actorId` is the representative member ID from the validated family session, and `actorDisplayName` is that member's current name at transition time. The idempotency receipt actor is the family session ID.
- `ADMIN`: `actorId` is the authenticated Better Auth user ID, and `actorDisplayName` is the authenticated user's name. The idempotency receipt actor is the same user ID.

History queries always include the requested `siteId` in their database predicate. Composite site/group/member foreign keys and the admin authorization lookup prevent history from another wedding from being returned.

## Idempotency, retry, and conflict behavior

`requestId` is scoped by wedding, request kind, and actor: public requests use `siteId/PUBLIC/FAMILY/sessionId`, while admin requests use `siteId/ADMIN/ADMIN/userId`. The receipt also stores the optional public group for tenant tracing and foreign-key protection. The server hashes a canonical request (including sorted member updates), stores the response body in `rsvp_request_receipt`, and serializes duplicate request handling. Reusing the same request ID with a different payload in the same scope returns `409 IDEMPOTENCY_KEY_REUSED`. A PostgreSQL regression reuses one request ID for the same administrative actor across two weddings and proves that neither replay nor response data crosses the site boundary.

The first successful write stores its response before returning. If the response is lost, retrying the identical request, including after the deadline, returns the stored response with `replayed: true`; it does not reapply state or history. This replay check intentionally precedes the public deadline rejection. A new request after the deadline receives `409 RSVP_DEADLINE_PASSED` for public writes. Admin writes have no deadline block while the site is active.

If every submitted state already matches and revisions are current, the server returns `NO_CHANGE` and stores a receipt without inserting history. If one submitted member has a stale revision, the server returns `409 RSVP_CONFLICT` with current `id`, `state`, and `revision` details for conflicting members. No submitted member is written and no history entry is inserted. Members omitted from the request cannot create a false conflict.

The shared guest UI keeps local selections, fetches current records, refreshes revisions, explains the conflict in Portuguese, and lets the representative review before retrying. A retry of the same intended update uses the same request ID while its payload and expected revisions remain unchanged. An explicit reload discards local changes and starts a new request identity.

## Persistence and transaction boundary

Block 4 adds:

- `guest_member.rsvp_state` with the three-state enum and `guest_member.rsvp_revision` starting at zero;
- paired nullable `site.rsvp_deadline_at` and `site.rsvp_deadline_timezone` columns with a database pair check;
- `rsvp_history` with site/group/member scope, before/after states, actor snapshot, and timestamp;
- `rsvp_request_receipt` with site, scope, actor, request hash, response status/body, and a unique site/scope/actor/request key.

The API locks and validates every submitted member in the tenant and group scope before applying any update. State changes, revision increments, history rows, and the idempotency receipt belong to one database transaction. A conflict, missing target, inactive-site rejection, or other transaction error leaves no partial state or history.

## Package and site boundary

`packages/wedding-features` exports the shared `GuestAccess`, `RsvpForm`, `RsvpDraft`, `RsvpMemberSnapshot`, `RsvpStatus`, and draft helpers through its public entrypoint. The component consumes the existing family-session transport and API origin/site configuration; it does not create authentication, a parallel session store, or database access. `confirmAllDraft`, `pendingRsvpUpdates`, and `reconcileRsvpDraft` are presentation-state helpers, not authorization.

`apps/wedding-demo` remains a host and QA surface. It chooses placement and styling and supplies public configuration; it must not embed RSVP data, sessions, credentials, or operational fixtures in static content. `packages/template-root` owns no RSVP rules. Block 6 may apply the final design through the shared exports without rewriting this state machine. Block 5 may consume the current RSVP contract for messages, reports, and quotas without changing RSVP authorization or making SMS a prerequisite.

## Static artifact privacy

The static build must succeed with no API, database, or SMS provider available. RSVP members, responses, family sessions, bearer tokens, deadlines, operational fixtures, phones, PINs, and credentials are runtime or test-only data. They must not appear in generated HTML, serialized editorial content, SEO metadata, sitemap, public fixtures, or committed browser evidence. Operational test fixtures remain separate from editorial demo content.

## Listening

The contract keeps one shared write shape for family and administrative actions so optimistic concurrency, idempotency, no-op handling, and history transaction rules cannot diverge by caller. Authorization remains different at the boundary: family scope comes from the validated session and active deadline, while admin scope comes from the authenticated account and assigned wedding. A nullable deadline pair was selected to represent “no deadline” without inventing a local timezone. History stores display snapshots alongside immutable IDs because an audit view must remain interpretable after later spelling corrections. A generic template adapter, per-member account model, client-clock deadline, or separate retry endpoint was rejected; the existing family bearer, shared feature exports, and request receipt provide the smallest compatible seam.
