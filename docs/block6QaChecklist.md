# Block 6 end-to-end QA checklist

Status: independent black-box execution and focused post-fix revalidation completed on 2026-09-13. The reusable procedure remains below; the executed result matrix and exact limits are recorded here and in `docs/block6Validation.md`.

## Executed result matrix

| Area | Result | Evidence or limit |
|---|---|---|
| Demo composition, story, gallery, schedule, venue, footer | PASS | Four agreed viewports; no overflow or clipped essential content |
| Reusable package and alternate fixture | PASS | Distinct data, reordered hero, local section, and `/hospedagem` with one H1 |
| SEO and static privacy | PASS | Complete metadata and `noindex, nofollow`; artifact scan repeated after final build |
| Navigation, focus, target sizes | PASS | Correct hero overlap states, 44px brand target, Escape/link focus restoration |
| Lenis and reduced motion | PASS | Normal, initial reduced, and runtime toggle behavior exercised |
| No-script progressive fallback | PASS | Script-aborted run keeps editorial content and honest guest/mural fallback |
| RSVP dialog and persistence | PASS | Native modal behavior plus POST 200, reload persistence, and restored original value |
| Authorized admin handoff | PASS | Public query removed; recognized mode shown; return reaches the same workspace |
| Mural availability and site lifecycle | PASS | Enabled/disabled and inactive/reactivated through supported UI; original state restored |
| Root OWNER site listing | BLOCKED | An unrelated legacy row in the shared test database violates the current slug contract and invalidates the list response; the fixture workspace itself passed |
| Message publish/edit | BLOCKED | No reversible supported delete/reset path was established for the empty fixture message |
| Deadline and foreign/primary-group matrix | BLOCKED | The bounded rerun ended before safe reversible identities and targets were selected |
| Final fictional-demo media and AI video | PASS | Approved WebP set and silent 1080p hero loop integrated on 2026-09-14; production and real-client gates remain separate |

The first independent run reported six failing checklist areas. Five public defects were corrected and passed independent revalidation. The apparent RSVP failure was disproved by a controlled real select/save/reload cycle and then independently revalidated. No product defect remains in the retested scope; the three blocked subscopes above are not passing claims.

## Preconditions and safety

- [ ] Confirm branch and exact revision; preserve unrelated work and record all uncommitted Block 6 inputs.
- [ ] Use a clean browser profile and distinct local public, admin, and API origins.
- [ ] Use `DATABASE_URL_TEST` only if protected guest/admin flows require database fixtures. Verify the disposable database identity before migration or mutation; never fall back to `DATABASE_URL` and never access production.
- [ ] Create only synthetic wedding, admin, family, RSVP, and message fixtures. Use an authenticated `OWNER` or assigned `SITE_ADMIN` for protected panel recognition; a static flag or route parameter is not authorization.
- [ ] Keep real SMS, media-generation providers, deployment, Cloudflare, Railway, production Neon, and external account mutation disabled.
- [ ] Run both static consumers without requiring the API, database, SMS, map, or media provider.

## Package and reuse boundary

- [ ] Confirm `@entrelacos/template-root` exposes only `./v1` and both consumers avoid deep and app-to-app imports.
- [ ] Scan `packages/template-root/src` for all demo/fixture wedding values and confirm no fixed wedding, editorial, navigation, SEO, venue, label, or media content exists.
- [ ] Exercise contract rejection for malformed serializable content, unsafe schemes/URLs, invalid canonical/social metadata, invalid/non-positive media dimensions, duplicate IDs, duplicate links, unresolved anchors, absent ordered sections, and a missing/duplicate hero.
- [ ] Build `apps/wedding-demo` and `apps/template-fixture` independently with no live runtime service.
- [ ] Confirm the demo uses the default preset while the fixture renders distinct identity/content/media/SEO, story-before-hero order, its local section, and direct `/hospedagem` route without a template fork.
- [ ] Override each supported CSS variable in a fixture and confirm the contract is limited to `--template-ivory`, `--template-olive`, `--template-ink`, `--template-muted`, and `--template-line`.

## Emitted HTML and static privacy

- [ ] Inspect every generated demo/fixture page for exactly one title, description, canonical, robots, Open Graph set, Twitter card set, social-image URL, and social-image alt.
- [ ] Confirm demo and fixture emit `noindex, nofollow`; record that this does not restrict public access.
- [ ] Confirm canonical and navigation targets are host-owned and resolve correctly across `/`, anchors, and `/hospedagem`.
- [ ] Scan built artifacts for database/provider URLs, Better Auth or Twilio secrets, tokens, cookies, PINs, phones, guest/member names from operational fixtures, RSVP data, messages, and server-only environment values.
- [ ] Confirm public artifacts contain only the fictional editorial demo/fixture content and intentional public origins/site configuration.

## Responsive visual flow

- [ ] Test at `390x844`, `768x1024`, `1440x900`, and `1920x1080` with screenshots and DOM/overflow checks.
- [ ] Verify no horizontal overflow, clipped controls, overlapping header, unreadable line length, or unstable section ordering.
- [ ] Verify hero crop, immediate image/poster fallback, supplied dimensions, navigation contrast, story media, gallery crop/controls, schedule, guidance, venue, map fallback, RSVP entry, mural entry, and footer.
- [ ] Confirm the header is transparent over the hero, becomes solid after it, and starts solid on `/hospedagem` and other no-hero pages.
- [ ] Confirm desktop/mobile breakpoints preserve content and the mobile story uses normal vertical flow with its canonical media.
- [ ] Confirm all visible interface text is `pt-BR` in the wedding experience; technical fixture copy may remain intentionally distinct but must be host-owned.

## Keyboard, focus, and no-JavaScript access

- [ ] Navigate all links, buttons, gallery controls, map actions, copy-address action, guest access, mural controls, and RSVP controls using the keyboard only.
- [ ] Confirm visible focus and at least 44px target height for shared navigation and public actions.
- [ ] Open/close the native mobile menu with keyboard, close it with Escape and link activation, and confirm focus returns to its summary.
- [ ] Navigate the gallery one full item at a time, open the selected item through the hover/focus expand action, operate the full-screen dialog controls, close with its button and Escape, and confirm focus returns to the visible opener without changing the page URL.
- [ ] Open the RSVP dialog from its trigger, confirm initial focus enters the dialog, close with its button and Escape, and confirm focus returns to the opener.
- [ ] Confirm the dialog remains independently scrollable and is marked `data-lenis-prevent`.
- [ ] Disable JavaScript and verify anchors, navigation, hero/story/gallery/schedule/venue content, visible address/fallback links, footer, and the gallery's horizontal-scroll media fallback remain available without turning media into direct file links. Runtime guest operations may show their honest unavailable boundary rather than static data.

## Smooth scroll and reduced motion

- [ ] In normal motion mode, confirm one Lenis instance uses `autoRaf: true`, `lerp: 0.095`, `smoothWheel: true`, `syncTouch: false`, `wheelMultiplier: 0.9`, and `anchors: true`.
- [ ] Confirm wheel anchors scroll smoothly, touch remains native, nested dialog scrolling is not captured, and no forced nested page scroll is introduced.
- [ ] Load with `prefers-reduced-motion: reduce` and confirm Lenis is not instantiated, entrances are immediately visible, transitions are removed, and the sticky story stage is replaced by normal vertical content.
- [ ] Change reduced-motion preference at runtime and confirm the active Lenis instance is destroyed and recreated only when motion is enabled again.
- [ ] Confirm the initial CSS hero entrance and generic reveals run once with restrained opacity/small vertical movement, never depend on final media, never hide content before enhancement, and introduce no blocking preloader, parallax, or keyboard trap.

## Venue and external fallback

- [ ] Confirm the host-supplied Google Maps iframe has an accessible title, lazy loading, approved HTTPS host/form, and no API key.
- [ ] Verify the exact address is visible and selectable when the iframe succeeds, is blocked, or is offline.
- [ ] Exercise copy-address success and failure feedback through the live region.
- [ ] Verify the Google Maps directions link and host fallback link open the intended public destination without credentials or session material.
- [ ] Record external iframe behavior as dependency evidence only; do not treat a local render as provider availability or legal/privacy approval.

## Guest features and admin-only panel access

- [ ] Confirm public and family visitors receive no `Painel` or `Voltar ao painel` option in static HTML, before recognition, or after a failed recognition.
- [ ] Complete the reviewed admin-to-public handoff with an authenticated authorized admin and confirm only a valid recognition displays `Modo administrador` and `Voltar ao painel`.
- [ ] Refresh, visibility-check, expire/revoke, and use a different site/origin to confirm recognition fails closed and never grants operational authority.
- [ ] Exercise guest lookup, PIN/session, RSVP, deadline/conflict, message edit, mural disabled/block, and API-unavailable states through the existing `wedding-features` UI without duplicating their Block 3–5 state machines.
- [ ] Confirm mural content is fetched at runtime with private fields absent and is never present in the static build.
- [ ] Confirm inactive publication renders the neutral public state and does not expose a panel link or operational data.

## Media gate

- [ ] Reconcile every file and external embed against `docs/block6MediaRegister.md`.
- [x] Confirm the former abstract demo SVGs were removed while the monogram remains visibly recorded as provisional.
- [x] Confirm the current demo uses the approved fictional-couple WebP set and silent H.264 hero video without moving host media into the reusable package.
- [x] Record the approved fictional-couple set, source/provider, usage scope, limitations, approval owner/date, dimensions, alt text, optimized formats, delivery sizes, and retained source identity.
- [x] Verify muted inline autoplay loop treatment, required poster, intro-to-video reset, physically absent audio stream, reduced-motion pause/static fallback, mobile rendering, and file size.
- [ ] Treat final logo/favicon/monogram approval, Google embed privacy review, and every third-party media permission as explicit pending gates until evidenced.

## Final repository gates and closure

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run typecheck --force`.
- [ ] Run `bun run test`.
- [ ] Run `bun run build --force`.
- [ ] Run `bun run test:db` only after the isolated `DATABASE_URL_TEST` identity and schema are verified, when integrated protected-flow QA is in scope.
- [ ] Run `git diff --check` and update Graphify after final source changes.
- [ ] Run an independent final diff review after black-box QA and correct every accepted in-scope finding.
- [ ] Record fixture cleanup, remaining worktree changes, exact limitations, and absence of commit, push, merge, deployment, provider call, and production access.

## Listening

The checklist separates implementation-agent evidence from independent acceptance because responsive screenshots alone do not prove protected recognition, runtime preference changes, operational feature states, or static privacy. It treats the fixture as a reuse probe, not a second wedding product, and keeps final media approval separate from rendering support so placeholders cannot become accidental launch assets.
