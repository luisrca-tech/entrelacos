# Block 7 integrated QA checklist

Status: frozen for Block 7 execution on 2026-09-16. This checklist turns the contracts in `docs/block7Contracts.md` and the inherited Blocks 1–6 behavior into executable evidence. A row is `PASS` only when the named evidence exists. `SKIPPED`, `BLOCKED`, and `UNPROVEN` are not passes.

## Evidence rules

- Use synthetic, owned identities and fixtures only. Never record credentials, session values, PINs, OTPs, phones, database URLs, or provider payloads.
- Verify `DATABASE_URL_TEST` identity before any database mutation. Never fall back to `DATABASE_URL`.
- Use a clean browser context for black-box QA. Record viewport, browser, revision, date, fixture IDs, and result without sensitive values.
- Capture the actual response status, stable error code, visible result, and cleanup result for every mutation.
- Label provider-related evidence exactly `simulated`, `unavailable`, `manual`, or `live`. Only authorized real-provider evidence may use `live`.
- Use the demo reset route as the supported cleanup path. Compare the unrelated sentinel before and after every destructive scenario.
- A reproducible in-scope defect is fixed and rerun before sign-off. An external dependency or human decision is recorded with its precise blocker.

## Preflight and fixture identity

- [ ] Record branch, revision, clean/dirty state, runtime versions, and relevant local ports.
- [ ] Run the frozen install and baseline gates.
- [ ] Verify test project, branch, endpoint, database, role, and `neon.branch_id` without printing their values.
- [ ] Prove the target differs from development and production; abort on absence, ambiguity, or mismatch.
- [ ] Create or identify the demo-marked site, OWNER, SITE_ADMIN, representative, guest family, and unrelated sentinel using synthetic data.
- [ ] Capture normalized pre-test snapshots of the sentinel and protected administrative records.
- [ ] Reset the demo to `block7-demo-v1` and record the returned counts and correlation ID.

## Automated reset and authorization matrix

| Scenario | Expected evidence |
| --- | --- |
| OWNER, exact origin, demo target, current dataset | `200`, no-store JSON, server request ID, expected counts |
| Missing session | `401 UNAUTHORIZED`; no rows changed |
| SITE_ADMIN session | `403 FORBIDDEN`; no rows changed |
| Missing or foreign origin | `403 FORBIDDEN`; no rows changed |
| Missing/non-demo target | indistinguishable `404 DEMO_SITE_NOT_FOUND`; no rows changed |
| Invalid JSON, unknown field, query override, or wrong version | stable validation error; no rows changed |
| Failure after deletion begins | full transaction rollback |
| Two same-site resets | serialized, both valid, one deterministic end-state |
| Two sequential resets at fixed clock | byte-equivalent normalized demo snapshot |
| Reset at later clock | only clock-derived fields differ as contracted |
| Unrelated tenant and sentinel | byte-equivalent before/after snapshots |
| OWNER/auth/config rows | unchanged and existing admin session remains usable |
| External provider spy | zero calls |

## Clean-browser functional matrix

Execute with `$qa-and-fix` and `agent-browser`. Use separate clean contexts when changing identity.

### OWNER

- [ ] Sign in, list sites, and open the owned demo without exposing another tenant.
- [ ] Exercise guest-group create/edit/delete and verify validation, representative ownership, and reversible cleanup.
- [ ] Exercise RSVP administrative update and confirm history/audit attribution.
- [ ] Publish, edit, moderate, and remove a message; reset and prove no residue. This closes inherited Block 6 gap 2.
- [ ] Review CSV and PDF exports for correct tenant scope, encoding, layout, and absence of unrelated data.
- [ ] Change deadline, quota, mural, and lifecycle only on the owned demo; verify public behavior and then reset.
- [ ] Attempt OWNER-only operations with a SITE_ADMIN and prove rejection.

### SITE_ADMIN

- [ ] Sign in through the supported access flow and verify only the assigned site is visible.
- [ ] Exercise allowed guest, RSVP, message, report, and moderation operations.
- [ ] Verify owner-account management, demo reset, and cross-site requests fail closed.
- [ ] Disable/revoke the controlled identity and prove the existing session/access behavior matches its contract.

### Representative and guest family

- [ ] Look up a controlled Brazilian group, complete `manual` verification, and establish the family session.
- [ ] Verify pending, partial, confirmed, and declined RSVP rendering and updates.
- [ ] Prove representative changes create the expected history without changing another group.
- [ ] Exercise message create/edit/remove with mural enabled, blocked group, and mural disabled states.
- [ ] Verify an expired/revoked family session and rate-limit burst fail with stable, non-disclosing errors.
- [ ] Prove the foreign group remains administrative-only and has no public phone flow.
- [ ] Exercise deadline before/after behavior for the primary Brazilian group and foreign group. This closes inherited Block 6 gap 3.
- [ ] Inject `simulated` provider acceptance/final failure/unknown and `unavailable`; verify labels never imply `live` delivery.

### Public, responsive, and accessible behavior

- [ ] Navigate all public editorial sections and owned links with JavaScript enabled and disabled where applicable.
- [ ] Validate desktop, tablet, and narrow mobile layouts without horizontal overflow or obscured controls.
- [ ] Complete interactive flows with keyboard only; verify logical order, visible focus, labels, errors, and focus restoration.
- [ ] Verify landmarks, headings, accessible names, contrast, and status/error announcements.
- [ ] Enable reduced motion and prove nonessential motion is removed without hiding content.
- [ ] Verify static output contains no operational records, credentials, session material, private phones, or API/database dependency.

## Inherited Block 6 gaps

- [ ] Root OWNER site list is tested with an isolated valid fixture. If an unrelated invalid legacy slug still breaks parsing, record the exact defect without mutating that row. Do not call the gap closed until the owned flow is reliable.
- [ ] Message publication/edit/removal is followed by demo reset and a clean normalized snapshot.
- [ ] Deadline, foreign group, and primary Brazilian group are exercised with controlled identities and reset cleanup.

## Observability and redaction

- [ ] Every exercised request emits parseable structured JSON with allowlisted fields, result, duration, and a server-generated request ID.
- [ ] Reset, errors, rate limits, and provider modes have explicit stable operation/result labels.
- [ ] Inject forbidden values into headers, cookies, bearer data, query strings, bodies, nested errors, guest names, phones, PIN/OTP fields, and provider payloads; prove none appear in captured output.
- [ ] Prove raw URLs, SQL, stack traces, request/response objects, and unbounded errors are absent.
- [ ] Confirm local stdout is the implemented sink and external retention/shipping remains an open gate unless separately approved.

## Load, burst, abuse, and isolation

- [ ] Use only a disposable verified test target, synthetic data, isolated ports, and no live provider.
- [ ] Record the exact 20-tenant by 500-guest fixture distribution and ensure it totals 500 per tenant.
- [ ] Record endpoint mix, concurrency stages, duration, requests, successes, errors by code, timeouts, rate limits, and p50/p95/p99.
- [ ] Include normal reads/writes, authentication/challenge bursts, RSVP/message operations, abuse bursts, and cross-tenant negatives.
- [ ] Compare tenant and sentinel snapshots; prove no cross-tenant writes or sensitive output.
- [ ] Clean every owned load fixture and prove cleanup. State resource observations and measurement limitations.

## CI and repository gates

- [ ] Frozen install, lint/format, typecheck, unit/contract tests, and all builds pass.
- [ ] Nested workspaces are discovered; both template consumers build.
- [ ] Public import ownership and emitted SEO/media assertions pass.
- [ ] Secret/sensitive-data scan and `git diff --check` pass.
- [ ] Database integration runs only with explicit verified disposable test credentials, or is visibly `BLOCKED`/`SKIPPED` rather than implicitly green.
- [ ] Wrong database, missing identity, pooled/direct mismatch, and branch/project/database/role mismatch tests abort before mutation.
- [ ] Recheck GitHub workflow IDs and runs. Do not call remote CI green until active `Validate` has a real successful run.
- [ ] Investigate `startup_failure` without changing GitHub settings unless explicitly authorized.

## Recovery and human gates

- [ ] Record Neon tier, retention/history, cost approval, authorized access, source marker, and disposable destination before any restore.
- [ ] If authorized prerequisites exist, restore to a separate destination, measure observed RPO/RTO, validate schema/tenants/sentinel/essential flows, and record disposition.
- [ ] If any prerequisite is absent, record the exact blocker and keep RPO/RTO `UNPROVEN`; do not substitute a mock or local dump as proof.
- [ ] Create the launch-gate register covering privacy, data rights, retention/deletion, client and demo media rights, support, providers, recovery, visual approval, and go/no-go.
- [ ] Each gate has a human owner, status, decision date, evidence, next action, and release impact. Unknown items remain open.

## Completion gates

- [ ] `docs/block7Validation.md` maps every result to evidence, command, date, and limitation.
- [ ] `docs/block7Handoff.md` records delivered behavior, residual risks, blocked gates, cleanup state, and exact next actions.
- [ ] The implementation plan and decision register are updated only for evidence actually produced.
- [ ] `graphify update .` completes after code changes and generated Graphify state remains ignored.
- [ ] No commit, push, PR, merge, deploy, production mutation, real SMS, or external configuration change occurred without later explicit authorization.

## Listening

This matrix separates automated database invariants from black-box browser evidence because neither substitutes for the other. It treats cleanup and sentinel comparison as part of every destructive scenario, not as a final best-effort step. Provider, recovery, CI, legal, and launch claims remain independently gated so a local technical pass cannot overstate production readiness.
