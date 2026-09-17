# Block 7 handoff

Date: 2026-09-16
Branch: `block-7/quality-demo-recovery`
Baseline: `07a7992e8ef727cf4ea4ff07b09e3aa9a7c78556`

## What is ready locally

- The demo reset contract, deterministic dataset, transactional service, OWNER-only HTTP route, and preservation/rollback/concurrency tests are implemented.
- Safe structured request/reset observability is implemented with server request IDs, a scalar allowlist, explicit rate-limit signals, and local stdout as the default sink.
- CI now gates workspace discovery, lint/format, typecheck, unit/contract tests, all builds, both public consumers, and emitted SEO/media. Database integration is visibly skipped when its explicit disposable-test configuration is incomplete.
- The synthetic load runner owns a unique `block7-load-*` partition, verifies the test database, measures the recorded stages, and removes its sites, guests, groups, and non-cascading lookup-rate-limit events in `finally`.
- Clean-browser OWNER and public evidence, defects, fixes, and remaining identity gaps are recorded under `docs/evidence/block7/browserQa/`.
- Recovery and launch decisions are recorded without claiming proof or legal approval.

## Frozen interfaces

- Reset route: `POST /v1/owner/sites/:siteId/demo/reset`.
- Exact body: `{ "datasetVersion": "block7-demo-v1" }`.
- Only authenticated `OWNER`, exact admin origin, and `site.isDemo = true` are accepted.
- Reset preserves site identity/configuration and administrative/auth rows; only demo operational data is replaced.
- `X-Request-Id` is server-generated and propagated by the admin BFF. It is correlation data, never authorization.
- Observability accepts only the fields listed in `docs/block7Contracts.md`; request/response/error objects and private visitor data are excluded.
- Persisted site reads tolerate historical repository slugs up to the documented legacy bound. New site creation retains the stricter 64-character contract.

## Open evidence and release blockers

1. Run SITE_ADMIN and representative/family flows in clean browser contexts using a secret-safe, approved one-time identity mechanism. Include guest-side deadline, message, session expiry/revocation, and provider simulated/unavailable variants.
2. Inspect controlled CSV/PDF contents without retaining private fixture data.
3. Extend load evidence if authenticated admin, RSVP/message writes, mixed group distributions, a separate sentinel snapshot, or cross-tenant negative traffic is required for acceptance. Current numbers apply only to the recorded shape and endpoint mix.
4. Produce a real successful remote run of the active `Validate` workflow after explicit authorization to push/open a PR. Local success is not remote CI evidence.
5. Select the Neon tier/retention/cost, authorize a recoverable source and separate disposable destination, then perform and timestamp a real restore. RPO/RTO remain `UNPROVEN` until then.
6. Assign and complete the human/legal/provider/rights/support/go-no-go decisions in `docs/block7LaunchGates.md`.
7. Keep deployment, main migration, domains/DNS, permanent environment provisioning, and production lifecycle work in Block 8.

## Cleanup state

Verified before handoff:

- no `block7-load-*` site or rate-limit event remains;
- the controlled browser-QA demo and OWNER were removed after final evidence;
- the local authentication vault entry was deleted;
- temporary API/admin/public servers were stopped;
- the ignored local admin `.env` was restored to its pre-QA localhost values;
- changed/untracked-text scanning found no configured credential, connection string, raw phone, PIN/OTP, private key, provider key, or bearer value in repository artifacts.

## Next authorized operation

The worktree intentionally remains uncommitted. A later reviewer should inspect [the validation record](./block7Validation.md), [the load report](./block7LoadReport.md), [the recovery record](./block7Recovery.md), and [the launch gates](./block7LaunchGates.md), then decide separately whether to authorize commit/push and the remaining external evidence.

## Listening

This handoff keeps unresolved external and identity-dependent work visible instead of treating local automated tests as equivalent evidence. The next block may consume the frozen reset and observability seams, but it must not broaden the template boundary or convert the technical fixture into another permanent environment.
