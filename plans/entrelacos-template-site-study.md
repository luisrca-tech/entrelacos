# Study: reusable wedding templates and independently owned sites

Date: 2026-09-12. Status: planning revision requested by the operator; implementation remains in Blocks 4–8. This study refines US-003 without introducing a CMS or changing Block 3 contracts.

## Evidence and baseline

The reference repository `/home/lfrca/naranja-labs/architecture-websites` was inspected read-only on `main` at `fc373444ef9112e3327b54b272b70ee99be8d9d8`. Graphify queries guided navigation; the findings below were verified in source. No reference tests, browser parity checks, or deployments were rerun for this documentation study.

EntreLaços planning changes are based on local `main` at `53fbd70`, in a separate worktree. Block 2 completion is recorded in `docs/block2Validation.md`; Block 3 is in development on `block-3/guest-groups-otp`, with uncommitted changes that this study neither merges nor modifies. Before publication, this study was rebased onto the updated `origin/main`, which includes Block 3 and its manual group PIN redesign. `docs/block3Validation.md` records local acceptance; live Twilio delivery remains pending. The branch/worktree description above records the original study baseline, not the current integration status. The older scaffold-wide status wording in some documents must not be used to infer current implementation coverage. Future integrations consume the reviewed contracts from each block rather than this study inventing replacement endpoints or session rules.

| Observed reference pattern | Source relative to architecture-websites | Application to EntreLaços |
| --- | --- | --- |
| Independent template packages expose `/v1` | `packages/templates/{off-white,black-and-white}/package.json` and `src/v1.ts` | Expose a reviewed presentation API; keep implementation paths private. |
| Hosts own routes, fixture copy, media and deployment | `apps/demos/README.md`, `apps/demos/*/src/pages`, `apps/demos/*/src/data` | The wedding app is a real consumer, including the demo. |
| Typed content with runtime validation and default interface messages | `packages/templates/off-white/src/contract.ts`, `packages/templates/black-and-white/src/v1/content.ts` | Validate public editorial data at build time; keep generic Portuguese messages reusable. |
| Public shells, page presets and selected components | Both `src/v1.ts` entrypoints | Support convenient presets and explicit composition from public sections. |
| Host controls injected through neutral slots | Off-white `HomePage.astro` and `Shell.astro`; demo `index.astro` with `beforeHeader` and `footerActions`; black-and-white equivalents with `footerAddon` | Keep demo banners and operational feature integration out of editorial content contracts. |
| Shared shell renders SEO from host values | Both template shells and black-and-white route configuration | Site owns SEO decisions; shared layout produces consistent tags. |
| Import boundaries have executable enforcement | `scripts/validate-boundaries.ts` and its tests | Test forbidden app imports and deep package imports, including relative paths. |

The reference is a pattern source, not a dependency to import. Its CMS-shaped types and site manifests serve that repository; EntreLaços has no CMS runtime requirement. A README currently links a missing `docs/template-demos-runbook.md`, so that runbook was not used as evidence.

## Gaps worth improving rather than copying

1. **Page composition is still relatively fixed.** Both home presets directly render their main sections. The public shells and selected components permit custom pages, but not every home section is independently exported. EntreLaços should export the sections actually needed by its default home and customization proof, so a host can reorder or replace one without copying the preset markup.
2. **Navigation assumes a fixed page family.** Off-white navigation keys are a fixed union; black-and-white route helpers enumerate architecture pages. Wedding navigation must accept validated host-owned paths and anchors, including an extra page. Route generation stays in Astro files; navigation does not become a second router.
3. **Content shapes are coupled to complete architecture sites.** Required project/team content is appropriate there. A wedding layout must not require gallery or story content merely to render an accommodation or privacy page. Use small section contracts; validate the complete set only when the host selects the complete preset.
4. **Public `/v1` is compatibility, not a frozen artifact.** Both reference packages are private version `0.0.0` workspaces. A workspace import resolves the current checkout. Reproducibility requires a reviewed Git revision, lockfile, build inputs and retained artifact, not the export suffix alone.
5. **Brand and metadata defaults must be explicit.** EntreLaços currently has scaffold defaults and an optional `head` slot. Final metadata should have one renderer and host-owned values, without duplicate canonical/robots tags injected by local pages.

## Responsibility contract

| Concern | Owner | Boundary |
| --- | --- | --- |
| Layout, accessible header/footer, section markup, spacing, responsive rules, default theme and motion | `packages/template-root` | No couple names, customer URLs, venue, customer photos, environment reads, provider calls or tenant checks. |
| Default complete page | `template-root` preset | Composes the same public sections available to hosts; does not register app routes. |
| Couple copy, dates, editorial venue details, navigation, page metadata, media selection, image alt/crop and local sections | Wedding app | Versioned public inputs and code reviewed by the operator. Never guest records or credentials. |
| Site ID, API/panel origins, canonical origin, base path and build environment | Wedding app configuration | Explicit build inputs; public site ID is not authorization. Reuse stable project identity but resolve environment-local IDs separately. |
| Guest identification, manual PIN/optional OTP UI, family session transport, RSVP, messages and administrative recognition | `packages/wedding-features` | Reuse each block's contracts and state handling. Presentation variation must not duplicate authentication or business decisions. |
| Authentication, deadline, mural controls, lifecycle, moderation, tenant access and operational data | Hono API and server-only database | Authoritative at request time; no wedding app or theme override can grant access. |
| UI primitives | `packages/ui` | Generic interaction/accessibility; no wedding-specific editorial composition. |
| Publication, deployment evidence, domains and rollback | Operator, per wedding | Manual, independently reviewed operations; shared package edits never trigger mass publication. |

Dependency direction: wedding app imports template and wedding-features; wedding-features imports shared HTTP contracts and UI as needed; the API owns business rules and database access. Template code does not import an app, the database or wedding-features. The host inserts feature components into editorial composition. Do not introduce a new adapter framework just to connect these existing packages.

## Proposed folder and export shape

Keep the existing package and demo names. A second branded template is not required by this study. Extract a neutral foundation and separate design packages only when a second real design creates a demonstrated need.

```text
packages/template-root/src/
  v1.ts                  # reviewed exports: layout, preset, sections, content types
  layouts/WeddingLayout.astro
  pages/WeddingHome.astro
  sections/              # HeroSection, StorySection, GallerySection, etc.
  content.ts             # public data validation, no transport or component registry
  styles.css             # documented theme variables and baseline styles
packages/wedding-features/src/
  ...                    # shared guest behavior from Blocks 3–5
apps/wedding-demo/
  src/data/content.ts
  src/data/media.ts
  src/siteConfig.ts
  src/pages/index.astro
  src/components/DemoBanner.astro
  src/assets/            # source media processed during build
  public/                # already optimized files and directly served assets
  astro.config.mjs
  wrangler.jsonc
apps/weddings/<project-key>/
  ...                    # same host responsibilities, independently built
  src/pages/hospedagem.astro
  src/components/TravelTipsSection.astro
```

Names above describe planned files, not delivered exports. Introduce `@entrelacos/template-root/v1` in B6-T0. Preserve existing `./layout`, `./section`, root and stylesheet imports during migration or migrate all current consumers in the same reviewed change. Do not rename every workspace to resemble the reference. Before adding nested apps, update Bun workspace globs and verify Turbo/CI discovery; the current flat scaffold is not proof that nested apps participate in checks.

Keep data as plain serializable objects: strings, finite numbers, booleans, arrays and records. Functions, Astro components, runtime sessions and arbitrary executable markup are not content. Dates are explicit ISO values with timezone semantics, not locale-dependent parsing. Component imports, ordering and conditional rendering stay in `.astro` composition code. A build-local media resolver may adapt Astro image metadata into section props; do not pretend an import function is serialized content.

## Three supported customization levels

1. **Content and theme:** use the default home preset with wedding data, media and documented CSS variables. Generic interface text may have template defaults; couple identity, canonical origin and approved artwork must come from the host. No selectors reaching into private markup.
2. **Section composition:** compose `WeddingLayout` and public sections explicitly. Omit an optional section, change order, or insert a host-owned section. Each section accepts its own content and unique ID; headings, anchors, gallery state and motion must work when reordered or used twice. Named slots are reserved for stable additions to a preset, not an expanding list of every possible insertion point.
3. **Additional or substantially different page:** add an Astro page in the wedding app, reuse the shared layout and any needed sections, then provide page-specific SEO and navigation. A unique page does not require a template fork, a new template version or an API endpoint unless it introduces new approved business behavior.

Illustrative composition, with proposed exports and fixture names:

```astro
---
import { WeddingLayout, HeroSection, StorySection } from '@entrelacos/template-root/v1';
import TravelTipsSection from '../components/TravelTipsSection.astro';
import { content } from '../data/content';
import { siteConfig } from '../siteConfig';
---
<WeddingLayout site={siteConfig} seo={content.pages.home.seo} navigation={content.navigation}>
  <HeroSection id="inicio" content={content.hero} />
  <TravelTipsSection id="viagem" content={content.travelTips} />
  <StorySection id="historia" content={content.story} />
</WeddingLayout>
```

The default preset must use those same sections internally. Local extensions own their responsive and accessibility checks. Promote a local section only after another consumer needs the same stable behavior; do not pollute the template with client-name branches. Shared CSS uses documented variables and local extensions use scoped styles. Scripts target their own section instance and release listeners when applicable; optional sections cannot be prerequisites for unrelated behavior.

Astro already supports component props, slots and slot forwarding, while `src/pages` defines the host routes. This is the native basis for this proposal, rather than a custom template engine. See [Astro components](https://docs.astro.build/en/basics/astro-components/) and [project structure](https://docs.astro.build/en/basics/project-structure/). Exact exports and compiled examples must be verified against the pinned repository version in B6-T0.

## Content, SEO and media ownership

Use small contracts for site identity/navigation, per-page SEO, and individual sections. Avoid one mandatory mega-object for every page and avoid a generic JSON section registry. Validate once before rendering the selected page; report the wedding, page and invalid field without printing sensitive data. Proposed negative cases include duplicate section IDs, missing referenced pages/anchors, empty required copy, invalid media dimensions, unsafe link schemes, unavailable preset data and invalid canonical configuration.

The host owns title, description, canonical origin/path, social image and indexing intent per page. The layout owns escaping and output of title, description, canonical, robots, Open Graph and card tags. Derive canonical and social URLs from the reviewed host origin, not the build machine URL. Do not place guest-specific data or session-bearing URLs in HTML, metadata, sitemap or structured data. Keep extra pages in the same metadata policy and verify one canonical and one robots directive per page.

Recommended initial indexing policy: demo and review builds are `noindex`; indexing a client site requires an explicit operator choice and approved copy. Noindex is not access control: public review remains publicly reachable. Changing a dashboard status cannot rewrite static robots tags. Indexing changes require a reviewed rebuild/deploy; do not equate business lifecycle with build metadata. A sitemap, if delivered, contains only eligible canonical editorial pages and follows the selected policy. Final client indexing preference is an open B6/B8 decision.

The app owns source files and their rights record: file/source, approval, usage restrictions and chosen crop/poster. Prefer imported source images in `src/assets` for build processing; `public` is for optimized pass-through files, icons and suitable static assets. Supply width/height, meaningful alt text or an explicit decorative designation, responsive variants and fallback media. Hero video must retain its poster, muted/inline treatment and reduced-motion fallback. There is no upload service or object-storage feature in this MVP. See [Astro image handling](https://docs.astro.build/en/guides/images/) for the distinction between processed source assets and public assets.

## Operational features without template coupling

Static editorial pages must build without a live API/database or SMS provider. They show useful story and practical content when JavaScript or the API is unavailable. Feature islands hydrate only when needed and show honest loading, unavailable, expired-session, deadline, conflict, disabled and inactive states.

B4/B5 deliver reusable RSVP/message behavior in wedding-features, including mobile full-screen and desktop modal presentation where specified. B6 composes that behavior into the final design without rewriting the state machine. Theme variables and narrow presentational props are sufficient initially; design-independent controllers or additional presentation adapters are justified only by a second real presentation.

The API remains authoritative for deadlines, availability and moderation. Do not freeze guest messages into the static build: public mural data is read at runtime so edits and deletions can take effect without a site rebuild. Cache behavior and refresh/invalidation acceptance belong to Block 5; do not claim an already-open browser updates instantly without a defined mechanism. Static feature visibility is presentation intent, never permission. Session storage and cross-origin handling must reuse the final reviewed Block 3 implementation.

Deactivation has two separate operations: API denial of public operations and manual replacement/removal of the static site across all serving origins. A frontend availability request improves feedback but cannot erase already published editorial assets. Preserve this Block 8 boundary.

## Reuse and release proof

The demo is the first normal consumer, not a package of defaults for real weddings. Its banner, fictional content, media and owner-authorized simulation entry belong to the demo host. Simulation authority remains in the API; a static `isDemo` flag is insufficient. A second deterministic local fixture host/composition must have different names, dates, navigation, SEO and media, plus an extra accommodation page and an inserted/reordered section. It is a test consumer, not a second production wedding or permanent database environment.

Both consumers import only the public template entrypoint and shared features. No host imports another app's fixtures, source or assets. Test both default and customized output, including the host-owned controls. Record evidence that a reusable style/section change reaches both builds, while a host-only change cannot leak to the other build. No production customer data is required for this proof.

Record each reviewed release's project key, environment-local site ID, template contract major, Git revision, lockfile/build-input identity, runtime versions, canonical origin, artifact checksum and deployment identifier. `/v1` in an npm export is independent of HTTP `/v1`. In a source workspace, rebuilding at a newer Git revision consumes newer compatible template code; the old deployed artifact stays unchanged until publication. Retain the earlier artifact for rollback. A need to freeze one template while independently updating other source requires a later package-release strategy, not a claim that `workspace:*` pins it.

## Delivery sequence and acceptance matrix

| Stage | Planned change | Required evidence |
| --- | --- | --- |
| Blocks 3–5 | Preserve guest/session authority; put RSVP and message integration in wedding-features | Existing block contract tests; a second-tenant negative case; no template dependency in business logic. |
| B6-T0 | Freeze minimal `/v1` presentation/data boundary; prove layout, one real reusable section and two host compositions | Failing tests before validation/route logic; build default plus customized host; extra route and section without deep imports or copied preset. |
| B6-T1–T3 | Implement hero, story and practical sections using that seam | Shared-section checks and rendered default/custom order, optional-section and unique-anchor checks. |
| B6-T4 | Navigation, extra page and feature insertion | Direct URL load, cross-page anchors, unique metadata and real guest boundaries from Blocks 3–5. |
| B6-T5–T6 | Responsive, accessible motion and approved media | Mobile/desktop, keyboard, reduced motion, image/poster fallbacks and rights evidence. |
| B7-T1–T2 | Integrate demo fixtures/reset and full behavior QA | Owner-only simulation, reset isolation and both visual compositions with API available/unavailable. |
| B7-T4 | Make ownership and consumer builds CI gates | Forbidden imports fail; nested host discovery works; no private guest data/secrets in output; deterministic builds need no live provider. |
| B8-T1–T2 | Provision thin hosts using the proven layout/content contract | Development default; no demo content/session copying; no overwrites of custom pages on resume. |
| B8-T3–T7 | Independent release and lifecycle operations | Reviewed metadata, exact artifact record, one-site deployment and rollback, manual inactive-site handling. |

B6-T0 and fixture-based visual work can proceed independently once their own scope and inputs are approved. Completion of B6/B7 still requires the integrated guest flows. Keep eight top-level blocks and existing task IDs; add B6-T0 as a prerequisite rather than renumbering unrelated work.

## Decisions still requiring concrete inputs

- Final visual direction, theme tokens, logo, approved fictional-couple assets and video treatment remain open.
- The initial supported section props and named slots are frozen with B6-T0's real examples; the illustrative names here are not an implemented contract.
- Per-client indexing policy and canonical domain must be recorded before publication. The recommended noindex defaults are not a promise of private staging.
- Media rights/provider/cost and production credentials remain existing gates. No new provider is selected here.
- A second design package, published package registry, self-service editor and declarative page builder are deferred until demonstrated requirements justify them.

## Listening

The selected pattern preserves the reference's package/host separation and versioned exports, while making individual editorial sections first-class public building blocks. Fixed presets alone were rejected because they encourage copying when a wedding needs a different section or route. A generic page builder, inheritance tree and plugin registry were rejected because operator-authored Astro composition already supports the requested flexibility. Existing template-root and wedding-demo names remain to avoid a speculative repository migration. The follow-up is an executable two-consumer proof in B6-T0, then full visual and operational acceptance in Blocks 6–8; this study changes documentation only.
