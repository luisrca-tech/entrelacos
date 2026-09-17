# Block 7 validation record

Status: the non-external implementation scope is locally implemented and the consolidated repository/database gates pass. Browser identity coverage, load breadth, remote CI, recovery, and human/legal gates remain limited as recorded below. This is not production or launch acceptance.

Date: 2026-09-16
Branch: `block-7/quality-demo-recovery`
Baseline: `07a7992e8ef727cf4ea4ff07b09e3aa9a7c78556`
Scope: local code, the verified disposable test database, local clean-browser execution, and read-only GitHub workflow inspection.

## Delivered behavior

- A strict `block7-demo-v1` contract and OWNER-only `POST /v1/owner/sites/:siteId/demo/reset` boundary.
- A transaction-scoped advisory lock, demo-marker recheck, deterministic rows, rollback, same-site serialization, and preservation of administrative/configuration and unrelated-tenant data.
- Server-generated request correlation, allowlisted structured JSON events, explicit local mode labels, and redaction tests. HTTP `429` events carry `rateLimitOutcome: limited`.
- Workspace-discovery and generated public-build gates, including both template consumers and emitted SEO/media assertions.
- A GitHub Actions quality job and an explicitly conditional disposable-database job. The workflow does not migrate main, deploy, or call a live provider.
- A repeatable synthetic load runner for the exact 20-wedding by 500-guest planning shape with latency percentiles, response codes, timeouts, rate limits, isolation snapshots, and verified cleanup.
- Browser fixes found during QA: an immediately accessible introduction skip, localized empty-form handling, hydration-safe login submission, safe API request-ID propagation through the admin BFF, and tolerant reads for pre-existing repository slugs while preserving the stricter create contract.
- Correct propagation of typed public guest lookup errors. Before the fix, lookup rate limits were flattened to `503`; the HTTP boundary now preserves their stable status and code.

## Focused automated evidence

TDD runs demonstrated the expected failures before implementation for reset behavior, authorization, redaction, public-build/workspace guards, browser regressions, request-ID propagation, legacy persisted-slug reads, and rate-limit propagation. The focused passing runs cover:

- deterministic reset state, sentinel preservation, rejection of non-demo/SITE_ADMIN targets, concurrency, and rollback;
- strict reset HTTP payload/origin/session behavior and safe operational events;
- observability allowlisting, request correlation, error handling, and explicit rate-limit signals;
- public challenge lookup-rate-limit propagation through the real PostgreSQL HTTP boundary;
- both CI helper gates and their negative cases;
- introduction skip/reduced-motion behavior, localized guest lookup validation, hydration-safe login, API proxy headers, and legacy read/create slug separation.

The final consolidated command results are recorded in the repository-gates section after execution. Database tests use only the guarded `test` target and verify its configured project, branch, endpoint, database, role, and server branch identity before mutation.

## Independent clean-browser QA

The independent run and post-fix rerun are recorded in [the browser report](./evidence/block7/browserQa/report.md). It exercised desktop, tablet, and mobile public behavior, keyboard/focus paths, reduced motion, OWNER site/workspace flows, RSVP administration/history/filters, exports, deadline, mural/moderation, message removal, lifecycle, quota/provider labels, and four successful same-origin demo resets. The final reset restored the controlled demo baseline.

The run also found and revalidated the four browser-facing defects listed above. The inherited OWNER root-list failure was closed without mutating the unrelated legacy row. Message removal plus reset and the OWNER-side deadline/foreign/primary-group matrix passed. Guest-side deadline and family behavior did not receive browser evidence.

The following remain `BLOCKED`, not passed:

- SITE_ADMIN activation, assigned-site scope, revocation, and OWNER-only denial in a clean browser;
- representative/family manual verification, RSVP/message mutation, guest-side deadline, expired/revoked session, and provider failure variants;
- download-content inspection for the browser-triggered CSV/PDF files.

No safe one-time identity/PIN transfer was established without exposing restricted values in automation evidence. Automated authorization, tenant, RSVP, message, export, session, and provider-state tests remain coverage but do not replace those black-box identities.

## Load, burst, abuse, and isolation

[The load report](./block7LoadReport.md) is the authoritative measurement record. The exact 20 × 500 fixture handled 3,000 requests across concurrency 5 and 20 with only expected `200` and `429` responses and zero timeouts. The report records per-stage p50/p95/p99, problem codes, resources, stable 20/20 tenant snapshots, and zero remaining fixture sites, groups, guests, or rate-limit events. The test database identity was verified before seed; no live provider was called.

The first diagnostic run exposed a real HTTP adapter defect: `GuestLookupServiceError` was not part of the public-router error boundary, so abuse responses appeared as generic `503`. A focused PostgreSQL regression and a repeated load run validate the corrected mapping. Load-created lookup-rate-limit events are explicitly deleted because their nullable group relationship does not cascade with site deletion.

The report covers the stated planning shape only. It is not a capacity guarantee. RSVP/message write traffic, authenticated admin load, mixed group shapes, a separately snapshotted sentinel, and cross-tenant negative load were not all exercised by the bounded runner and remain explicit limitations rather than inferred passes.

## CI evidence and remote status

The active local workflow is `Validate` (workflow ID `354895961`). Read-only GitHub inspection on 2026-09-16 found no run for that active workflow. Historical run `35143879623` belongs to the removed `BuildFailed` workflow (ID `354895986`), contains zero jobs, and is classified as `startup_failure`; the available metadata does not prove a more specific root cause.

The replacement workflow syntax and local commands are validated, but remote CI is `UNPROVEN` until an authorized push or pull request produces an actual active-workflow run. No GitHub setting was changed.

## Recovery and launch gates

[The recovery record](./block7Recovery.md) remains `UNPROVEN`. No real restore was attempted because Neon tier, retention, cost approval, recoverable source, authorized restore access, and a verified separate disposable destination were not supplied. No RPO/RTO claim is made.

[The launch-gate register](./block7LaunchGates.md) records privacy, data rights, retention/deletion, media rights, support, provider, observability-sink, authentication, recovery, and go/no-go ownership. Missing human/legal decisions remain open and no LGPD, provider, media-rights, recovery, or launch approval is inferred.

## Repository gates

Final consolidated results are populated only from commands executed on this worktree:

- `bun install --frozen-lockfile`: 582 installs across 842 packages checked with no changes;
- `bun run check:workspaces`: every app/package workspace is declared and present in the lockfile;
- `bun run check`: 242 files passed Biome, all 8 typecheck tasks passed with zero Astro diagnostics, 73 files/319 tests passed, and all 4 application builds passed;
- `bun run check:public-builds`: both template consumers passed emitted SEO/media gates;
- `bun run test:db`: after re-verifying the disposable test identity, 24 files/108 PostgreSQL tests passed in 166.59 seconds;
- `actionlint .github/workflows/ci.yml`: passed;
- changed/untracked-text scanning found no configured database/auth/provider value, credential-bearing URL, bearer value, private key, provider key, raw Brazilian phone, or raw six-digit PIN/OTP;
- `git diff --check`: passed;
- `graphify update .`: passed and rebuilt the ignored local graph to 2,618 nodes, 5,229 edges, and 156 communities. Graphify reported its known partial-parser warnings for Astro and selected test/migration metadata; source typecheck/tests/builds above are the correctness evidence.

## Operational boundary

No commit, push, pull request, merge, deploy, production mutation, main migration, live SMS, restore, media-provider call, or external configuration change is part of this evidence.

## Listening

The reset is deliberately one versioned operation instead of a general demo-profile system. Structured stdout remains the smallest safe observability boundary while sink selection and retention are human/infrastructure decisions. The public guest error fix preserves typed abuse responses at the HTTP seam rather than teaching the load runner to accept false service failures. Browser and load gaps remain named because automated service coverage cannot be promoted into black-box or production evidence.
