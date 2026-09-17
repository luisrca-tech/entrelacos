# Block 7 demo, quality, observability, and recovery contracts

Status: frozen for Block 7 implementation on 2026-09-16. This document freezes the local demo reset, quality evidence, observability, CI, recovery, and human-gate boundary. It does not authorize a production migration, deployment, provider call, legal claim, commit, or push.

## Scope and existing invariants

Block 7 proves the existing Blocks 1–6 slices together. The Hono/Node API and PostgreSQL remain the authority for authorization, tenant isolation, lifecycle, guest identity, RSVP, messages, exports, quotas, and reset behavior. `apps/wedding-demo` remains a host and QA surface. `apps/template-fixture` remains a technical reuse fixture, not a permanent demo environment.
The following rules remain in force:

- `OWNER` is global; `SITE_ADMIN` is assigned to one site. Authorization is server-side.
- Public sites never connect directly to Neon and never contain operational records, credentials, sessions, PINs, phones, RSVP data, or message data in static output.
- Browser origins are exact registered origins. Wildcard CORS, URL credentials, cross-site credential cookies, and tenant selection by client input are forbidden.
- Manual PIN is the MVP guest path. Simulation is explicit and never proves Twilio delivery, cost, or account readiness.
- Inactive sites preserve data and reject public mutations. Administrative reads remain subject to their existing contracts.
- Main migrations, production data changes, deployment, domains, provider configuration, and lifecycle publication remain manual operations.

## Demo identity and authorization

The demo is one existing site row identified by `site.isDemo = true`. Its stable `site.id` is the only demo identity used by the reset operation. No new permanent database, Neon branch, third demo app, or demo tenant is introduced.
The reset boundary is:

```text
POST /v1/owner/sites/:siteId/demo/reset
```

The request requires:
1. the existing authenticated Better Auth administrative session;
2. an exact configured admin `Origin` matching the session's allowed admin origin;
3. the `OWNER` role, not merely site membership; and
4. a site path that resolves to a demo-marked site inside the transaction.

The body is strict JSON with exactly one field:
```json
{
  "datasetVersion": "block7-demo-v1"
}
```

Unknown fields, another version, query-string overrides, bearer-only access, missing origin, foreign origin, absent session, `SITE_ADMIN`, and non-demo targets fail closed. An absent or non-demo site returns the same `404 DEMO_SITE_NOT_FOUND` boundary; it must not reveal whether another tenant exists. Authentication and role failures use the existing `401 UNAUTHORIZED` and `403 FORBIDDEN` problem shapes.
Successful responses use `application/json`, `Cache-Control: no-store`, and contain only:

```json
{
  "siteId": "site-demo",
  "datasetVersion": "block7-demo-v1",
  "result": "RESET",
  "resetAt": "2028-04-01T12:00:00.000Z",
  "counts": {
    "groups": 5,
    "members": 10,
    "messages": 1
  }
}
```

`X-Request-Id` is a server-generated UUID returned on every response. It is a correlation value, not an authorization token. Responses and errors never return PINs, phones, session tokens, cookies, request bodies, provider references, or database details.
## Reset transaction and lock contract

The reset is one PostgreSQL transaction. Before reading or changing demo data, it obtains a transaction-scoped advisory lock derived only from a namespaced site key:
```sql
SELECT pg_advisory_xact_lock(
  hashtextextended('entrelacos:block7:demo-reset:' || $1, 0)
)
```

The implementation must re-read `site.isDemo` after acquiring the lock. All deletes, baseline updates, seed inserts, and response counts commit together. Any validation, foreign-key, provider, or database error rolls back the complete reset. The reset never calls an SMS, media, map, deployment, or other external provider.
Concurrent resets for the same site serialize on this lock. A second reset may wait and then succeed against the same version. It must not interleave rows or leave a partial dataset. Resets for different sites are independent, but tests still use isolated resources and do not run concurrent writers against the same fixture database unless the test explicitly owns the partition.

Idempotence means equal end-state, not equal request timestamps: two resets with the same fixed clock and dataset version produce the same normalized rows, IDs, relations, states, and counts. A reset at a later clock produces timestamps derived from that one captured clock only. No `Date.now()` call, uncontrolled randomness, or generated UUID may enter deterministic dataset fields.
## Reset scope

### Preserved data

The reset preserves the demo site's identity and host configuration:

- `site.id`, `repositorySlug`, `provisioningKey`, display names, partner names, event date, and public URL;
- the `isDemo` marker, which must remain `true`;
- registered `site_origin`, `site_domain`, and `site_term` rows;
- `user`, `account`, `session`, `verification`, `site_membership`, and `admin_access_token` rows, including OWNER and SITE_ADMIN credentials and administrative sessions; and
- every row belonging to every non-demo site, including the sentinel site and its users, memberships, guest data, messages, RSVP, quotas, and sessions.

Preservation means no reset-triggered password rotation, account disablement, admin-session revocation, domain change, origin change, or tenant-wide query. If a test needs a clean administrative session, it creates and owns that session separately.

### Removed and recreated operational data

The reset removes only site-scoped operational rows for the demo site, then recreates the deterministic dataset:

- `guest_group` and `guest_member`;
- `guest_verification_challenge`, `guest_verification_send`, and `guest_rate_limit_event`;
- `family_session`;
- `family_message` and `message_request_receipt`;
- `rsvp_history`, `rsvp_request_receipt`, and `rsvp_request_receipt_group`;
- `sms_usage` and `sms_send_reservation`.

Deletes must use the demo `siteId` predicate and respect the existing composite foreign-key boundaries. No broad `TRUNCATE`, unscoped delete, cascade from the sentinel, or direct production-table operation is permitted.

The site row is updated to the Block 7 baseline while keeping its identity and host configuration:

| Field | Reset baseline |
| --- | --- |
| `isDemo` | `true` |
| `lifecycle` | `ACTIVE` |
| `previousLifecycle` | `null` |
| `publicationState` | `PUBLISHED` |
| `rsvpDeadlineAt` / `rsvpDeadlineTimezone` | both `null` |
| `muralEnabled` | `false` |
| `smsMonthlyLimit` | `null` |

`updatedAt` is set from the captured reset clock. A test may temporarily configure lifecycle, deadline, mural, quota, message blocking, representative data, or provider state, but the supported cleanup operation is the reset route itself.

## Deterministic dataset contract

The current dataset version is the exact string `block7-demo-v1`. Its IDs, relationship graph, member ordering, RSVP states, messages, challenge states, rate-limit events, and synthetic values are fixed in source and covered by contract tests. The dataset contains at least:

- `b7-group-pending`: every member `PENDING`;
- `b7-group-partial`: a mixture of `PENDING` and `CONFIRMED` members;
- `b7-group-confirmed`: every member `CONFIRMED`;
- `b7-group-declined`: every member `DECLINED`; and
- `b7-group-foreign`: `isForeign = true`, no phone, and administrative RSVP only.

At least one group has a representative change recorded in its controlled scenario history, and at least one deterministic message exists while the mural baseline is disabled. The seed also exercises a pending/locked manual challenge and rate-limit events at known clock offsets. Simulated accepted, final-failure, and unknown provider outcomes are available through the test fixture; an unavailable provider is a runtime failure injection, never a fake persisted live result.
The reset clock contract is:

```ts
interface DemoResetClock {
  now(): Date;
}
```

The service calls `now()` once after lock acquisition. All `createdAt`, `updatedAt`, expiry, challenge, rate-limit, RSVP-history, message, and usage timestamps derive from that instant and fixed offsets. Tests use a fixed UTC clock. Production-like local runs may use the current UTC instant, but evidence must record it. The manual PIN seed remains a valid fixed 64-character lowercase hexadecimal value per group; plaintext PINs never enter the dataset or evidence.

## Isolation and sentinel invariants

Every reset test creates or identifies a non-demo sentinel site and captures a normalized snapshot before the operation. The snapshot includes site configuration, users, accounts, admin sessions, memberships, domains/origins, groups, members, RSVP/history, messages, receipts, family sessions, rate-limit events, SMS usage/reservations, and row counts. After reset:

- every sentinel snapshot field is byte-for-byte equal;
- every unrelated tenant snapshot field is byte-for-byte equal;
- global OWNER identity, password hash, and administrative sessions remain valid;
- no sentinel or unrelated site ID appears in a reset delete or insert predicate;
- a non-demo reset attempt is rejected and changes no row; and
- the demo site contains only the current version's rows and no previous guest, family, message, RSVP, challenge, or quota residue.

Cross-tenant negative tests use mismatched site, group, session, origin, and admin identities. They must return the existing stable error boundary without disclosing another tenant's data. Sentinel comparison is mandatory after both successful and rejected reset attempts.

## Quality-state labels

Evidence and runtime responses use these exact lowercase labels where a provider or operation mode is reported:

| Label | Meaning | May claim live provider delivery? |
| --- | --- | --- |
| `simulated` | Deterministic local/mock provider or quota exercise | No |
| `unavailable` | Provider or dependency was intentionally unavailable or failed before a live result | No |
| `manual` | Human-operated path, including copied group PIN | No |
| `live` | Real provider operation with authorized credentials and captured provider evidence | Only with the complete gate |

`simulated`, `unavailable`, and `manual` must never be rendered as `live`, omitted, or described as delivery success. A mocked Twilio response is `simulated`; a real request that ends in provider `UNKNOWN` is not delivery proof.
## Structured observability contract

The default sink is local structured JSON/stdout. Every event is produced through an allowlist, not by serializing a request or error object. Allowed fields are:

```text
timestamp, level, event, requestId, routeTemplate, method, status,
durationMs, operation, result, siteId, actorRole, mode,
rateLimitOutcome, datasetVersion, count, errorCode
```

Fields are omitted when not applicable. `requestId` is the server-generated correlation UUID. `siteId`, route templates, role, status, counts, and stable error codes are allowed only when they do not identify private guest data.

The following are never logged: request/response bodies, query strings, full URLs, `Authorization`, cookies, bearer values, CSRF values, activation or handoff links, PINs, OTPs, raw phone or email values, guest/member names, message text, session IDs, hashes, database URLs, passwords, secrets, SQL, stack traces, raw provider payloads, or unbounded error objects. Redaction tests must inject each forbidden class and assert complete absence from captured output, including nested values and error paths.

Operational events must distinguish reset, request, rate-limit, provider, and error outcomes using `operation`, `result`, `mode`, `rateLimitOutcome`, and `errorCode`. An external sink is not part of this block; retention, access, and shipping remain an open operational decision.

## Load and abuse evidence contract

The planning target is 20 active weddings with 500 guests each. It is not a hard capacity promise. Every load report records the actual shape, not only the intended target:

```text
runId, date, revision, environment, database identity, duration,
tenant count, guests per tenant, group-shape distribution,
endpoint mix, concurrency stages, request count, success count,
error count by code, timeout count, rate-limit count,
p50/p95/p99 latency, resource observations, isolation result,
cleanup result, and limitations
```

The 500 guests per wedding distribution is explicit and totals exactly 500 per exercised wedding. The report names the counts of one-member, couple, family, foreign, and other groups actually used. It includes reads, RSVP writes, message writes where owned, authentication/challenge bursts, rate-limit bursts, and cross-tenant negative requests. Results describe observed behavior for the tested shape only.

Load runs use a disposable API/database target, isolated ports, synthetic data, unique request IDs, and no live SMS or external provider. Before and after snapshots prove no cross-tenant writes, no sentinel changes, no secret output, and complete fixture cleanup.

## CI and wrong-database protections

CI gates cover frozen installation, workspace-discovery, lint, typecheck, unit/contract tests, builds for both public consumers, import ownership, emitted SEO/media assertions, secret scanning, `git diff --check`, and PostgreSQL integration when explicit test resources exist. CI never runs a production migration, deploy, or main-data mutation.

Database integration must construct the existing test connection with target `test`, which accepts only `DATABASE_URL_TEST`. Before migrations or writes, it verifies:

- `neon.branch_id` equals `DATABASE_TEST_BRANCH_ID`;
- `neon.project_id` equals `DATABASE_PROJECT_ID`;
- `neon.endpoint_id` and parsed endpoint match the expected test endpoint;
- `current_database()` equals `DATABASE_NAME`; and
- `current_user` equals the expected test role when configured.

The test endpoint and branch must differ from development and production. Missing `DATABASE_URL_TEST`, missing identity expectations, a pooled/direct endpoint mismatch, a branch mismatch, a project mismatch, a database mismatch, or a role mismatch aborts before migration or test startup. There is no fallback to `DATABASE_URL`.

Workflow conditions consume secrets through environment variables and do not interpolate secrets directly into `if:` expressions. Secrets and connection strings are masked and never echoed. If test credentials are absent, the integration job is explicitly `blocked` or `skipped`, never green by implication.

## Recovery and RPO/RTO proof

The target is RPO at most one hour and RTO at most eight hours. The target remains `unproven` until a real restoration exercise records:

- selected Neon project, branch, tier, retention/history window, and cost assumption;
- source marker timestamp and selected restore point or equivalent provider evidence;
- destination branch/endpoint identity, database, role, and isolation checks;
- operation start/completion timestamps and observed RPO/RTO calculations;
- schema, tenant, sentinel, and essential-flow validation on the destination; and
- cleanup authorization and destination disposition.

The destination is separate and disposable. The source is never overwritten. A local dump/import, mock provider, documentation-only drill, or unavailable backup proves procedure readiness only and leaves RPO/RTO `unproven`. Missing Neon access, tier, retention, cost approval, legal retention decision, or provider operation leaves the corresponding gate `blocked` or `unproven`.

## Human and legal gates

The implementation may record gate status but cannot infer legal approval. The launch register must contain one row per item with `gate`, `owner`, `status`, `decisionDate`, `evidence`, `nextAction`, and `releaseImpact`. Required rows are:

- privacy notice and data-minimization review;
- retention schedule, deletion exceptions, and rights-request handling;
- client media permission, likeness/usage scope, source and approval record;
- administrative recovery and support procedure;
- provider/account/region/cost authorization, including real SMS;
- backup/restore retention and RPO/RTO decision;
- final visual/logo/media approval and production performance; and
- go/no-go owner decision.

`pending`, `blocked`, and `unproven` are valid outcomes. Technical tests must not be described as LGPD compliance, client consent, legal approval, provider delivery, commercial capacity, or production acceptance.

## Inherited Block 6 gaps

Block 7 must explicitly re-test the three gaps recorded in `docs/block6Validation.md` and `docs/block6Handoff.md`:

1. The root OWNER site-list check must use an isolated/owned fixture or document the unrelated invalid legacy slug without mutating it. The invalid row must not be silently normalized or treated as a product pass.
2. Message publication/edit must use the demo dataset and the reset route as the reversible cleanup path. The run must prove publication, revision behavior, and cleanup after reset.
3. Deadline plus foreign-group plus primary-group behavior must run with controlled identities: public foreign groups remain administrative-only, the primary Brazilian group follows the deadline/session contract, and reset restores the baseline.

These gaps remain open until execution evidence closes them. A skipped or unsafe scenario is `blocked`, not `PASS`.

## Operational boundary

This contract authorizes local implementation and disposable-test evidence only. It does not authorize changing GitHub or Neon settings, sending SMS, calling media providers, deploying, migrating main, creating a permanent environment, committing, pushing, merging, or opening a pull request.

## Listening

The reset uses one fixed version and a site-scoped advisory lock because repeatable cleanup is more valuable than a general-purpose demo profile system. Administrative identity, origins, domains, terms, and sessions are preserved so the operation cannot become an account-reset shortcut; only demo operational rows are recreated. A disabled mural and no deadline form the safe baseline, while lifecycle, deadline, quota, provider, and representative scenarios are temporary state exercised and then reset. The observability allowlist rejects raw request/error serialization, and every external capability remains separately labelled and gated because local simulation cannot prove provider, legal, recovery, or production readiness.
