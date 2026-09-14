# Block 6 validation record

Status: implementation, independent post-fix black-box QA, and fictional-demo media integration passed for the exercised Block 6 scope. The consolidated post-QA repository run and independent diff review are recorded below. This record must not be read as real-client, production, deployment, provider-workflow, or launch acceptance.

Date: 2026-09-14
Branch: `block-6/public-wedding-experience`
Baseline: `origin/development`
Scope: local reusable template, demo host, technical fixture, public feature placement, responsive interaction, and documentation only.

## Implemented surface inspected

- `@entrelacos/template-root/v1` is the only package export and contains the reusable layout, home preset, seven public section components, serializable contracts, and validators.
- `apps/wedding-demo` owns the complete Marina & Caio preset data, public feature placement, noindex SEO, venue/map configuration, provisional monogram, approved fictional-couple WebP set, and silent hero MP4.
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

## Post-review presentation feedback validation

The subsequent client-style presentation review expanded the demo story from two to four host-owned chapters, replaced the gallery's direct media links and anchor controls with one full media item per Embla carousel index, added a hover/focus expand action and full-screen Base UI dialog, increased hero viewport height, added a media-independent page-load entrance, reduced the venue/confirmation/mural spacing, removed the repeated footer year, and applied pointer cursors to enabled buttons.

The focused contract run passed 4 files and 33 tests. The current repository gates then passed:

- `bun install --frozen-lockfile`: 582 installs across 842 packages checked, no changes;
- `bun run lint`: 234 files checked, no fixes;
- `bun run typecheck --force`: 8 tasks passed without cache, with 0 Astro errors, warnings, or hints in both consumers;
- `bun run test`: 65 files and 277 tests passed;
- `bun run build --force`: API, admin, wedding demo, and template fixture builds passed without cache;
- `git diff --check`: passed.

The focused browser run used `1440x900` and `390x844`. It confirmed a 793.67px desktop hero, an 844px mobile hero matching the full viewport, no horizontal overflow, one gallery item per index, 44px square previous/next controls, no direct gallery-media links, unchanged page URL during navigation, selected-item dialog opening, full-viewport dialog sizing, Escape closure with focus restoration, and pointer cursors on the gallery, address-copy, guest-access, and mural buttons. Under reduced motion, the hero had no active animations and Lenis was absent; normal mode exposed the six intended CSS hero entrance animations. The browser reported no page errors.

The temporary authenticated fixture was removed from the verified test database. Its local state, credential, login-response, and environment files were deleted; the original admin `.env` was restored; B6 browser sessions and local servers were closed. The pre-existing `b4-qa-auth` browser session was left untouched.

## Full-width and gallery-derived introduction validation

The next visual feedback pass used the public One Hudson page and its local implementation only as interaction and spatial references. No One Hudson branding, copy, content, or host asset entered the template. The reusable implementation added optional host-owned intro labels; `WeddingHome` derives the visual sequence from host-owned gallery media and finishes with the host-owned hero media. The demo expanded from three to six gallery items. Those items were provisional host SVGs at this historical validation stage and were replaced by the final fictional-demo WebP set in the later media-integration pass below.

The focused TDD run first demonstrated four expected failures plus one missing helper module. After implementation, 5 focused files and 37 tests passed. The repository gates then passed with 239 linted files, 8 successful typecheck tasks and zero Astro diagnostics, 66 test files and 283 tests, both static consumer builds, and `git diff --check`.

Browser validation exercised normal motion at `1440x900`, `1920x1080`, `2560x1440`, and `390x844`. It confirmed:

- the gallery-derived sequence, hero-frame viewport expansion, subsequent header/content reveal, restored document scrolling, and no page error;
- exact `100svh` hero heights of 900, 1080, 1440, and 844 pixels at the corresponding viewports;
- no horizontal overflow at any exercised width;
- a 1440px story stage of 878.8px and gallery frame of 904.3px, materially wider than the prior centered composition;
- proportional 1920px growth to a 1192.3px story stage and 1226.9px gallery frame;
- the same 1192.3px and 1226.9px media widths at 2560px, confirming that the centered 1920px stage cap prevents indefinite 2K/4K stretching;
- a single-column 390px layout with a 358px gallery frame and the sticky story stage disabled;
- initial reduced motion skips/removes the intro, leaves header and hero content fully visible with no animation, and preserves native scrolling.

The introduction was visually captured during the centered first frame and after the final hero reveal on desktop, plus the centered first frame on mobile. This historical pass validated structure, timing, reuse, and responsive geometry before the final fictional-demo media existed.

## Introduction handoff, story transition, and gallery-height refinement

The follow-up TDD pass first produced three expected failures covering hero-media preparation, story-stage opacity transitions, and the shorter gallery ratio. After implementation, the same 3 focused files and 9 tests passed.

Browser validation at `1440x900` confirmed that the matching canonical hero media is visible beneath the final 450ms intro fade, with no white interval, while the header and masked hero copy wait until the overlay has been removed and then enter smoothly together. The viewport remained at scroll position zero, the final hero filled the viewport, and the browser reported no page errors.

The desktop story-stage transition was sampled 80ms after an active-entry change: the outgoing and incoming media had opacities `0.615233` and `0.384767`; after 800ms they had settled at `0` and `1`. The main desktop gallery frame changed from the previous 4:3 height of approximately 678.2px to 565.2px at a 904.3px width (`16 / 10`). At `390x844`, it remains 358px by 268.5px (`4 / 3`), the story stage remains disabled, and there is no horizontal overflow.

The final repository run for that refinement passed `bun install --frozen-lockfile` without changes, linted 239 files, completed all 8 typecheck tasks with zero Astro diagnostics, passed 66 test files and 285 tests, built the API, admin, wedding demo, and template fixture, and passed `git diff --check`.

## Final fictional-demo media and development-server validation

The approved host media replaced all eleven demo placeholder SVGs with optimized WebP files and added the 1920x1080, eight-second H.264 hero loop. The repository MP4 has no audio stream. The hero uses muted inline autoplay, loops continuously, pauses at frame zero for initial reduced motion, and keeps a nested image fallback. The introduction still derives its first six frames from the gallery. Its final frame is now a WebP extracted from the exact first decoded video frame, so the fullscreen expansion and fade remain visually continuous when playback begins beneath the overlay.

The focused TDD cycles first failed because the demo still referenced the prior poster and because video preparation, playback, overlay removal, and chrome entry were not separate stages. After the corrections, the boundary, intro, and hero suites passed 3 files and 14 tests. Browser sampling at `1440x900` captured the final intro frame, the crossfade while the hero video was already playing, and the completed hero. It confirmed the same poster path in intro and hero, playback beginning during the fade, no intermediate blank or unrelated still, and no page errors. Instrumentation recorded playback at approximately 6.43 seconds, overlay completion at 6.88 seconds, and header/copy animation startup on a later paint at 6.91 seconds; no long task occurred during that handoff, and the 900–1000ms chrome animations completed normally.

The development page initially failed while the static build passed because Astro dev externalized the source-only `@entrelacos/ui` workspace package and Node could not resolve its extensionless TypeScript component exports. A regression test reproduced the missing SSR bundling configuration. Adding `vite.ssr.noExternal: ["@entrelacos/ui"]` to the demo Astro configuration fixed the real development server without changing package exports. The prior explicit-extension experiment was rejected because Node then reported an unknown `.tsx` extension. The corrected development site responded and rendered at `http://127.0.0.1:4321/`.

The final repository gate used Bun 1.3.14, confirmed 582 frozen installs across 842 packages without changes, linted 228 files, completed 8 typecheck tasks with zero Astro errors/warnings/hints, passed 66 test files and 288 tests, and built the API, admin, wedding demo, and two-page template fixture successfully. The final `git diff --check` also passed after the documentation update.

## Contract and static-build evidence

Current source tests cover:

- serializability, metadata, safe URL schemes, canonical rules, media dimensions/poster, section IDs, home order, optional-section handling, extension anchors, Google Maps embed/directions forms, and footer labels;
- one `/v1` package export, no deep/app-to-app consumer imports, absence of known demo identity/venue values from template source, the extra fixture route, local extension, and host-owned assets;
- hero image/video fallback, muted inline autoplay loop, canonical story reading order and desktop/mobile/reduced-motion behavior, gallery fallback, schedule/venue rendering, metadata completeness, and named-slot landmarks;
- Lenis option equality and create/destroy/recreate behavior through a controlled `MediaQueryList` test;
- mobile-menu Escape/link closure and focus restoration;
- RSVP dialog focus capture/restore helpers and `data-lenis-prevent` integration;
- build-cache invalidation inputs for public admin origin and inactive publication state.

Both consumer builds were executed without a live API, database, SMS service, or media provider. The demo and fixture source use `noindex, nofollow`. The final post-fix generated artifacts passed the privacy and duplicate-ID scans recorded above.

The documentation pass reran the content, public-boundary, and interaction contract files with `bunx vitest run packages/template-root/src/content.test.ts packages/template-root/boundary.test.ts packages/template-root/src/interactions.test.ts`: three files and 29 tests passed. It cross-checked the five documented theme-variable names against `packages/template-root/src/styles.css`, reconciled the then-current host asset register against both `public` directories, verified the referenced local documents exist, and passed `git diff --check`. Later presentation and final-media passes superseded that asset inventory and revalidated the changed contracts. The repository Biome configuration ignores Markdown; no Markdown lint/format pass is claimed.

## Known evidence limits

- The B6-T5 implementation browser could not dispatch a live preference-change event, but the independent browser run later exercised initial and runtime reduced-motion transitions successfully; the lifecycle also remains covered by its controlled `MediaQueryList` test.
- Authorized clean-browser admin recognition, RSVP persistence, mural availability, and site lifecycle were accepted. Message creation/editing and the deadline/foreign/primary-group matrix remain blocked as described above.
- Google Maps iframe rendering depends on an external service. No provider availability, account, cost, privacy, or legal approval was verified.
- The fictional-couple stills and video are approved only for this demo. Final logo/monogram, exact model identifiers and generation costs, real-client rights, production network/device performance, and launch approval remain unverified.
- No layout-shift metric, performance budget, accessibility conformance claim, deployment, public demo URL, remote CI run, new commit, push, merge, or production operation is evidenced for the latest visual-feedback pass.

## Remaining acceptance gates

- approve real-client media and production performance separately before any launch using assets beyond this fictional demo;
- resolve or isolate the unrelated invalid shared-test row before using the root OWNER list as future QA evidence;
- run the currently blocked message and deadline/group scenarios only with a documented reversible fixture path;
- obtain explicit authorization before commit, push, merge, deployment, provider use, or production access.

## Operational boundary

This implementation integrated owner-generated final fictional-demo media but did not call a media provider, send SMS, change external maps, mutate development/production data, deploy, create a permanent environment, commit, push, or merge. Database-backed final QA, if needed, must use only the verified disposable `DATABASE_URL_TEST` target.

## Listening

The record keeps pre-final evidence because it is valuable for regression diagnosis, but labels it by execution stage. The repository-wide 259-test run predates B6-T5, the first presentation-feedback run superseded the earlier 272-test count with 277 passing tests, and the full-width/intro pass superseded it with 283. The introduction was implemented before final media because it derives from the reusable media contract. The final fictional-demo assets are now approved locally; real-client rights, exact provider/model/cost records, production performance, and launch acceptance remain separate gates.
