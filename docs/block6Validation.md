# Block 6 validation record

Status: implementation and independent post-fix black-box QA passed for the exercised Block 6 scope. The consolidated post-QA repository run and independent diff review are recorded below. Final media approval remains pending. This record must not be read as production, deployment, provider, or launch acceptance.

Date: 2026-09-13
Branch: `block-6/public-wedding-experience`
Baseline: `origin/development`
Scope: local reusable template, demo host, technical fixture, public feature placement, responsive interaction, and documentation only.

## Implemented surface inspected

- `@entrelacos/template-root/v1` is the only package export and contains the reusable layout, home preset, seven public section components, serializable contracts, and validators.
- `apps/wedding-demo` owns the complete Marina & Caio preset data, public feature placement, noindex SEO, venue/map configuration, monogram, and provisional abstract assets.
- `apps/template-fixture` owns the distinct Casa Aurora data and asset, noindex SEO, reordered preset, local section, and `/hospedagem` route.
- `packages/wedding-features` supplies runtime guest access, mural, RSVP dialog behavior, and admin recognition; operational authority remains in the API.
- Lenis, generic reveals, navigation focus behavior, story fallback, and RSVP dialog focus/scroll exclusion are implemented without adding a public interaction API.

## Recorded implementation evidence

The B6-T0 through B6-T4 implementation pass reported:

- `bun run test`: 60 files and 259 tests passed before the later B6-T5 interaction changes;
- `bun run lint`: passed;
- uncached typecheck/build of admin, wedding demo, and template fixture: passed;
- emitted metadata, routes, import boundaries, and `git diff --check`: passed.

The later B6-T5 pass, after the Lenis, reveal, mobile-menu, and dialog-focus changes, reported:

- `bunx vitest run packages/template-root packages/wedding-features`: 16 files and 78 tests passed;
- uncached typecheck of template fixture, wedding demo, and wedding features: passed;
- uncached builds of wedding demo and template fixture: passed;
- Biome checks and `git diff --check`: passed.

Its implementation-browser run covered `390x844`, `768x1024`, `1440x900`, and `1920x1080` and reported:

- no horizontal overflow at the four viewports;
- Lenis present in normal mode and absent when reduced motion was active at initial load;
- canonical story content visible and the sticky stage disabled under reduced motion;
- mobile menu closure and focus restoration after Escape;
- browser and temporary server closed after execution.

This browser run was performed within the implementation slice and was followed by the independent execution below.

## Independent black-box QA

The dedicated black-box executor used clean `agent-browser` sessions against the local demo, alternate fixture, admin, and API origins. It did not inspect product source or edit product files. The first run covered 20 checklist areas and reported 11 PASS, 6 FAIL, and 3 BLOCKED. The accepted public defects were:

- a transparent header before a reordered lower hero;
- focus loss after mobile anchor activation;
- a 26px brand target;
- indefinite guest/mural loading when scripts failed;
- a missing H1 on `/hospedagem`.

Each defect received a focused failing test where logic was involved, a minimal correction, and independent browser revalidation. The rerun reported 9 PASS, 0 FAIL, and 3 BLOCKED. It confirmed correct header states before/over/after the reordered hero, summary focus restoration, a 44px brand target, honest script-failure fallback, one accommodation H1, RSVP POST 200 plus reload persistence, immediate authorized admin recognition/return, mural enable/disable, and site inactive/reactivated behavior. RSVP, mural, and lifecycle state were restored afterward.

The initial RSVP failure was a QA-method false positive: both a main-agent controlled reproduction and the independent rerun produced POST 200 and durable reload state before restoring the original response. The root OWNER listing remains environmentally blocked because one unrelated legacy row in the shared test database has a 68-character repository slug that violates the current 64-character response contract. Direct access to the fixture's supported authenticated workspace passed. Message publication and the deadline/foreign/primary-group matrix remain explicitly untested because a verified reversible cleanup path or safe target was not established during the bounded rerun.

The browser evidence is stored outside the repository under `/tmp/entrelacos-b6-qa/run` and `/tmp/entrelacos-b6-qa/rerun`; it contains no recorded credentials, PINs, phone numbers, cookies, authorization values, request bodies, or private family screenshots.

## Consolidated final gates

The final local worktree passed:

- `bun install --frozen-lockfile` with Bun `1.3.14`: 579 installs across 839 packages checked, no changes;
- `bun run lint`: 228 files checked, no fixes;
- `bun run typecheck --force`: 8 tasks passed without cache, including 0 Astro errors, warnings, or hints in both consumers;
- `bun run test`: 64 files and 272 tests passed;
- `bun run build --force`: API, admin, wedding demo, and template fixture builds passed without cache; the demo emitted one static page and the fixture emitted `/` plus `/hospedagem`;
- `bun run test:db`: the guarded isolated database setup accepted only `DATABASE_URL_TEST`; 23 files and 103 tests passed in 162.94 seconds;
- `git diff --check`: passed;
- final demo/fixture artifact scan: 18 files inspected with no configured database/auth/Twilio secret value and no synthetic operational family/owner value found;
- emitted HTML check: demo `/`, fixture `/`, and fixture `/hospedagem` each contain exactly one title, description, canonical, robots tag, OG image alt, Twitter image alt, and H1; all three emit `noindex, nofollow`.

The independent final diff review found four P2 issues: duplicate fallback IDs, incomplete H1 styling in `TemplateSection`, missing collision validation for generated section IDs, and premature handoff wording. All four were corrected. Four focused test files with 31 tests passed before the consolidated repository gates above, and the reviewer then found only three documentation-status inconsistencies; those statements were aligned with the completed QA and artifact evidence. The reviewer's final read-only follow-up returned PASS with no remaining actionable finding.

The temporary authenticated fixture was removed from the verified test database. Its local state, credential, login-response, and environment files were deleted; the original admin `.env` was restored; B6 browser sessions and local servers were closed. The pre-existing `b4-qa-auth` browser session was left untouched.

## Contract and static-build evidence

Current source tests cover:

- serializability, metadata, safe URL schemes, canonical rules, media dimensions/poster, section IDs, home order, optional-section handling, extension anchors, Google Maps embed/directions forms, and footer labels;
- one `/v1` package export, no deep/app-to-app consumer imports, absence of known demo identity/venue values from template source, the extra fixture route, local extension, and host-owned assets;
- hero image/video fallback, no autoplay, canonical story reading order and desktop/mobile/reduced-motion behavior, gallery fallback, schedule/venue rendering, metadata completeness, and named-slot landmarks;
- Lenis option equality and create/destroy/recreate behavior through a controlled `MediaQueryList` test;
- mobile-menu Escape/link closure and focus restoration;
- RSVP dialog focus capture/restore helpers and `data-lenis-prevent` integration;
- build-cache invalidation inputs for public admin origin and inactive publication state.

Both consumer builds were executed without a live API, database, SMS service, or media provider. The demo and fixture source use `noindex, nofollow`. The final post-fix generated artifacts passed the privacy and duplicate-ID scans recorded above.

The documentation pass reran the content, public-boundary, and interaction contract files with `bunx vitest run packages/template-root/src/content.test.ts packages/template-root/boundary.test.ts packages/template-root/src/interactions.test.ts`: three files and 29 tests passed. It cross-checked the five documented theme-variable names against `packages/template-root/src/styles.css`, reconciled every registered SVG path against both host `public` directories, verified the referenced local documents exist, and passed `git diff --check`. The repository Biome configuration ignores Markdown; a targeted invocation reported zero processed files, so no Markdown lint/format pass is claimed.

## Known evidence limits

- The B6-T5 implementation browser could not dispatch a live preference-change event, but the independent browser run later exercised initial and runtime reduced-motion transitions successfully; the lifecycle also remains covered by its controlled `MediaQueryList` test.
- Authorized clean-browser admin recognition, RSVP persistence, mural availability, and site lifecycle were accepted. Message creation/editing and the deadline/foreign/primary-group matrix remain blocked as described above.
- Google Maps iframe rendering depends on an external service. No provider availability, account, cost, privacy, or legal approval was verified.
- Current SVG artwork and monogram are provisional local placeholders. No final fictional-couple set, final logo, media provider, AI video, cost ceiling, source rights, usage permission, optimized output, or approval record exists.
- No layout-shift metric, performance budget, accessibility conformance claim, deployment, public URL, remote CI run, commit, push, merge, or production operation is evidenced here.

## Remaining acceptance gates

- approve or replace the provisional media set, including any later AI-generated hero video and its rights/performance evidence;
- resolve or isolate the unrelated invalid shared-test row before using the root OWNER list as future QA evidence;
- run the currently blocked message and deadline/group scenarios only with a documented reversible fixture path;
- obtain explicit authorization before commit, push, merge, deployment, provider use, or production access.

## Operational boundary

This implementation and documentation run did not generate final media, call a media provider, send SMS, change external maps, mutate development/production data, deploy, create a permanent environment, commit, push, or merge. Database-backed final QA, if needed, must use only the verified disposable `DATABASE_URL_TEST` target.

## Listening

The record keeps pre-final evidence because it is valuable for regression diagnosis, but labels it by execution stage. The repository-wide 259-test run predates B6-T5, so the later 78-test focused run is recorded separately instead of implying one consolidated result. Final media remains an approval gate even though the code already supports image/video rendering and poster fallback.
