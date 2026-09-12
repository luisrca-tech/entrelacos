# Block 4 handoff

Status: Block 4 implementation and its authorized local validation are complete on `block-4/member-rsvp`. The branch contains the RSVP contract, API, database, admin, and shared feature slice. Executed evidence is recorded in `docs/block4Validation.md`.

## Delivered boundary for the next block

Block 4 supplies a member-level RSVP capability built on the Block 3 family session. It exposes the three-state model (`PENDING`, `CONFIRMED`, `DECLINED`), explicit save, partial responses, confirm-all as a local draft shortcut, server-authoritative deadline, member revisions, all-or-nothing conflicts, idempotent retries, current admin operations, and a separate operational history view.

The API and database remain authoritative. `packages/template-root` and a wedding host cannot change authorization, deadline, tenant scope, conflict rules, persistence, or history through presentation props, static flags, route IDs, or demo configuration.

## Public feature exports

The public entrypoint `packages/wedding-features/src/index.ts` currently exports:

- `GuestAccess`, which restores the existing site-namespaced family bearer and loads the RSVP read model after authentication;
- `RsvpForm` and `RsvpFormMember`/`RsvpFormProps` types;
- `RsvpDraft`, `RsvpMemberSnapshot`, and `RsvpStatus` types;
- `createRsvpDraft`, `setDraftStatus`, `confirmAllDraft`, `pendingRsvpUpdates`, and `reconcileRsvpDraft` helpers;
- existing Block 3 guest-session transport and error utilities used by RSVP.

`RsvpForm` props are presentation-focused:

```ts
type RsvpFormProps = {
  open: boolean;
  members: Array<{
    memberId: string;
    fullName: string;
    isRepresentative: boolean;
  }>;
  draft: RsvpDraft;
  canEdit: boolean;
  readOnlyMessage?: string;
  busy: boolean;
  error?: string;
  notice?: string;
  onChange: (memberId: string, status: RsvpStatus) => void;
  onConfirmAll: () => void;
  onSave: () => void;
  onReload: () => void;
  onClose: () => void;
};
```

The form does not call the API or persist state. The host/controller owns transport, draft state, conflict recovery, and placement. The current shared implementation uses an HTML dialog for desktop and CSS full-screen behavior at mobile width, with the same members, callbacks, draft, and API flow.

## API integration points

Public runtime calls use the existing `GuestAccessApi` and family bearer:

1. `GET /v1/public/family/session` restores the validated Block 3 family session.
2. `GET /v1/public/family/rsvp` loads members, revisions, deadline, `serverNow`, `canEdit`, and read-only reason.
3. `POST /v1/public/family/rsvp` sends only changed member IDs with current expected revisions and a UUID `requestId`.
4. On `RSVP_CONFLICT`, the shared UI reloads remote state while retaining local selections and allows a reviewed retry.
5. On `RSVP_DEADLINE_PASSED`, the UI displays read-only responses and never reports a save.
6. On a 401 family response, existing Block 3 session cleanup runs; no parallel token refresh or storage is introduced.

Public requests require `Authorization: Bearer <family-token>`, exact registered origin, `credentials: omit`, and `cache: no-store`. The API derives the site/group from the session. Site and member IDs are response identifiers and request targets only; they never grant access.

Administrative consumers use the existing admin session and exact admin origin:

- `GET /v1/sites/:siteId/rsvp?groupId=&state=` reads current groups and totals;
- `POST /v1/sites/:siteId/rsvp` writes one or more member states;
- `GET/PATCH /v1/sites/:siteId/rsvp/deadline` reads or updates the nullable deadline pair;
- `GET /v1/sites/:siteId/rsvp/history` reads filtered cursor pages.

All write payloads use strict schemas and `application/problem+json` errors. Preserve machine codes `RSVP_CONFLICT`, `RSVP_DEADLINE_PASSED`, and `IDEMPOTENCY_KEY_REUSED`; preserve `SITE_INACTIVE`, `SESSION_INVALID`, `FORBIDDEN`, `UNAUTHORIZED`, `NOT_FOUND`, and `VALIDATION_ERROR` boundaries from the API.

## Block 5 handoff

Block 5 may consume the current RSVP read model for messages, reports, and monthly SMS policy. It must preserve:

- the family session as the only public identity proof;
- site/group tenant predicates and inactive-site behavior;
- `PENDING` as a durable state;
- member revisions and idempotency receipts;
- separate history semantics and no-op/replay rules;
- the fact that SMS state never gates an already authenticated RSVP operation.

Exports and reporting may read RSVP state and history through new reviewed contracts, but must not place private guest data in the public static site or create a second RSVP mutation path. PDF/CSV work belongs to Block 5; Block 4 does not implement export.

## Block 6 handoff

Block 6 can apply the final wedding design around this seam:

- Compose the shared public RSVP entry and `RsvpForm` through public `wedding-features` exports.
- Select placement, labels/styles, and modal/full-screen visual treatment through narrow props or host composition.
- Keep loading, unavailable, invalid-session, deadline, conflict, no-op, and network error states visible and accessible.
- Preserve one implementation and one draft state machine for desktop and mobile.
- Keep all member records, responses, bearer sessions, deadlines, and operational fixtures out of static content, generated HTML, SEO, and public fixture data.
- Do not import `apps/admin`, `apps/api/src`, package-private `src` paths, database schema, or another host's fixtures.
- Do not move deadline or authorization decisions into `template-root`, Astro build code, or design tokens.

The template/site study's responsibility contract remains authoritative: the host chooses location and presentation; API and server-only database own operational rules. A second presentation is not a reason to introduce adapters, plugins, a page builder, or a parallel controller.

## Validation completed

- [x] Reviewed migrations passed against verified `DATABASE_URL_TEST` and were then applied to development.
- [x] Real PostgreSQL service/HTTP tests, concurrency, and two-wedding isolation passed.
- [x] `bun install --frozen-lockfile`, `bun run check`, `bun run test:db`, and `git diff --check` passed.
- [x] Independent browser QA passed desktop modal, mobile full-screen, draft/save, partial, deadline, admin correction, conflict recovery, revocation, and API failure paths after one fix and rerun.
- [x] Static build and artifact privacy scans passed without live API/database/SMS dependencies or embedded family data.
- [x] Graphify was updated and its generated state remains ignored.

See `docs/block4Validation.md` for counts, limitations, and the sanitized evidence location.

## Listening

This handoff keeps the public feature seam small: `GuestAccess` owns the existing identity flow, `RsvpForm` owns accessible presentation, and the API owns operational truth. A generic adapter or template-owned RSVP controller was rejected because it would duplicate state and make Block 6 design work capable of changing Block 4 authorization. The explicit export, prop, and privacy boundary lets Block 5 consume data and Block 6 restyle presentation without rewriting RSVP behavior.
