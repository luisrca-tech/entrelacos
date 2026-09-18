# Block 6 public template contracts

Status: the local Block 6 implementation is present on `block-6/public-wedding-experience`. The package, consumer, focused interaction, typecheck, build, independent black-box QA, and independent diff-review gates recorded in `docs/block6Validation.md` passed for the exercised scope. Final media approval remains pending. No deployment or production operation is covered by this contract.

## Ownership boundary

`packages/template-root` owns reusable public presentation only:

- the document layout, metadata rendering, navigation shell, footer shell, standard home preset, and editorial section rendering;
- the `/v1` TypeScript contracts and synchronous validation of host inputs;
- the five documented theme variables, responsive layout, progressive reveals, story presentation, and Lenis lifecycle;
- safe rendering for host-provided links, media dimensions, Google Maps URLs, section IDs, and extension anchors.

The package contains no fixed wedding, couple, venue, date, editorial, navigation, control-label, SEO, canonical, indexing, footer, or media content. It does not read application environment variables, call the API, access a database, create a session, or own RSVP/message/admin authorization.

Each site host owns every route, visible string, identity, date, venue, navigation and control label, section ID and order, canonical and indexing decision, social metadata, asset, alt text, media dimensions, map and fallback URL, feature placement, environment value, and local extension. Host data must be supplied through the public contracts; it must never be hidden as a default in `template-root`.

`packages/wedding-features` owns reusable runtime guest/admin presentation and transport. The API remains the authority for authentication, tenant scope, RSVP deadlines and writes, mural state, moderation, and admin recognition. A template host may place these features but cannot replace their operational rules.

## Public package surface

`@entrelacos/template-root` exposes only `@entrelacos/template-root/v1`. Direct imports from package source, removed legacy root/layout/section exports, and app-to-app imports are unsupported.

The `/v1` entrypoint exports these components:

- `WeddingLayout` and `WeddingHome`;
- `HeroSection`, `StorySection`, `DetailsSection`, `GallerySection`, `ScheduleSection`, `VenueSection`, and `TemplateSection`.

It exports the corresponding content types and validators for site identity, page SEO, navigation, footer, image/video media, hero, story, generic details, gallery, schedule/guidance, venue, section IDs, serializability, layout props, and home props. The versioned package export is a source-compatibility boundary; it is unrelated to the API's HTTP `/v1` routes and does not pin a deployed Git revision.

## Serializable data and validation

Content accepts plain records and arrays containing strings, finite numbers, booleans, and `null` where the concrete contract permits it. Functions, components, `Date`, `Map`, `Set`, cycles, class instances, and non-finite numbers are rejected.

The current validators enforce:

- non-empty required strings and positive finite media dimensions;
- safe relative, anchor, or HTTP(S) links; protocol-relative URLs, credentials, control characters, backslashes, and non-HTTP schemes are rejected;
- absolute HTTP(S) canonical and social-image URLs, with no canonical fragment;
- robots values exactly `index, follow` or `noindex, nofollow`;
- section IDs matching `^[A-Za-z][A-Za-z0-9:_-]*$`, with uniqueness across rendered top-level and nested home content;
- unique navigation targets and resolution of home-page anchors, including host-declared `extensionAnchorIds` for stable extension content;
- omission, rather than `null` or `false`, for optional sections and layout values;
- exactly one hero in a non-empty home order and no order entry for absent content;
- complete host-owned hero-intro labels and gallery media whenever the standard home preset enables that intro.

`WeddingHome` derives the order `hero`, `gallery`, `story`, then each remaining supplied optional section in the contract order when `sectionOrder` is absent. A supplied order may omit or reorder optional sections, but must include `hero` exactly once.

## Layout, slots, and theme

`WeddingLayout` requires `locale`, `site`, and complete per-page `seo`. Navigation and footer are optional for direct-layout pages. `WeddingHome` requires navigation and hero data and sets the hero-layout hint only when the hero is the first rendered section. A direct `WeddingLayout` consumer may set `hasHero: true` only when the page begins with a hero; the default is the solid navigation state. `TemplateSection` renders its title at level 2 by default and accepts `headingLevel: 1` for a host-owned standalone page title.

The stable named slots are:

- `head` for host-owned head additions;
- `header-addon` and `admin-access` inside the header;
- `before-main` and `after-main` inside the main landmark;
- `footer-addon` inside the optional footer.

The minimum theme contract for `/v1` consists of exactly these CSS variables:

- `--template-ivory`;
- `--template-olive`;
- `--template-ink`;
- `--template-muted`;
- `--template-line`.

Hosts may override those variables. No other variable, internal class, DOM selector, font stack, spacing value, or private markup detail is a supported `/v1` theme contract.

## Editorial sections and media

- `HeroContent` requires title content, date label, location label, and media. Its action and three introduction labels are optional and host-owned. Images render eagerly with explicit dimensions. Video requires a poster and renders muted, looped, inline, and without autoplay; the poster/image child is the fallback. When the standard home preset enables the introduction, it derives the sequence from the supplied gallery and finishes with the hero media, so the host does not duplicate media configuration. Video frames use their required posters during the introduction.
- `StoryContent` requires one host-owned `body` and one validated `media` asset. `StorySection` presents that content as a single full-bleed image/video with a short readable overlay; additional couple photos belong in `GalleryContent`. Mobile, reduced-motion, no-JavaScript, and unsupported-observer paths keep the same compact composition available in normal document flow.
- Section eyebrows are optional host labels; the default demo uses semantic labels without artificial `01 /`, `02 /`, `03 /`, or `04 /` prefixes.
- `GalleryContent` requires at least one item and host-owned previous, next, expand, and close labels. Every item remains in document order with explicit dimensions and occupies one full Embla carousel index. Media is not a direct file link. Hover or keyboard focus reveals the expand action, and activation opens the synchronized collection in a full-screen Base UI dialog. The main carousel uses a shorter `16 / 10` frame on desktop and `4 / 3` on mobile. Before hydration, the canonical media remains available as a horizontal-scroll fallback.
- `ScheduleContent` requires at least two entries and may include host-owned practical guidance. Times are display strings supplied by the host; the template does not interpret timezone or event semantics.
- `VenueContent` requires a visible address, safe Google Maps embed, Google Maps directions URL, host fallback link, and all accessible/copy-feedback labels. The address remains selectable and copyable even if the external map does not render.
- `FooterContent` requires host-owned names, date, links, RSVP label/target, year, copyright, and attribution.

Media objects are either images with `src`, `alt`, `width`, and `height`, or videos with the same fields plus a required `poster`. Media files and rights records belong to the host. The contract provides rendering and fallback behavior, not optimization, licensing, provider selection, or content approval.

## Navigation, motion, and focus

Navigation is fixed and is transparent only while the header overlaps a hero. It remains solid before a hero in a reordered composition and after the hero; pages without a hero also start solid. Desktop navigation changes to the host-labeled native `details`/`summary` menu at the current `960px` breakpoint. Native links remain usable without JavaScript; enhancement closes the menu after link activation or Escape and restores focus to the summary after the anchor's default action. Interactive navigation targets have a minimum height of 44px and visible focus styles.

Smooth wheel scrolling uses Lenis `1.3.26` with the approved options:

```ts
new Lenis({
  autoRaf: true,
  lerp: 0.095,
  smoothWheel: true,
  syncTouch: false,
  wheelMultiplier: 0.9,
  anchors: true,
});
```

The package imports `lenis/dist/lenis.css`. It does not instantiate Lenis while `prefers-reduced-motion: reduce` matches. A runtime change to reduced motion destroys the instance; disabling reduced motion recreates it. Touch scrolling remains native because `syncTouch` is false. RSVP dialog scrolling is excluded with `data-lenis-prevent`.

Generic entrances are progressive: content is visible before JavaScript, then enhanced with one-time opacity and small vertical-translate reveals when `IntersectionObserver` is available. The story uses the same local reveal for its single overlay copy while its background media resolves with a subtle scale. Without host intro data, the hero keeps its compact CSS entrance. With intro data, a decorative full-screen layer presents the host-owned label, reveals gallery frames, and expands the final hero frame to the viewport. The matching canonical hero media is prepared beneath the layer before its fade, preventing a blank handoff; the canonical header and masked hero-copy entrance start only after the layer is gone. Scrolling is locked only while that bounded sequence runs; media errors and a timeout cannot leave the page locked. Both desktop and mobile heroes occupy `100svh`. Reduced motion skips the introduction and removes all story and generic entrance transitions.

Desktop editorial sections use a viewport-proportional internal scale based on `1440px`, capped at `1.3333` by `1920px`. Content keeps a `40px` desktop gutter through the cap; beyond `1920px`, the stage remains centered at a maximum `1920px` width instead of stretching indefinitely. Story uses a viewport-height full-bleed composition while the gallery allocates the larger column to imagery. At `960px` and below, the layout returns to a single column and a `16px` gutter. These internal scaling variables and class names are not public theme tokens.

The RSVP dialog opens as a native modal, moves focus to its first control, closes through its button or Escape, and restores focus to the opener. Its scrollable content stays independent from Lenis.

## Map, indexing, and static privacy

The host manually supplies the Google Maps iframe URL. Accepted embed forms use HTTPS on `google.com`, `www.google.com`, or `maps.google.com`; directions use approved Google Maps paths. No API key, geocoding service, or map provider account is part of the template. The host also supplies a visible address and external fallback link because iframe availability remains external.

`apps/wedding-demo` and every `apps/template-fixture` page currently emit `noindex, nofollow`, one canonical URL, and complete Open Graph/Twitter image metadata. `noindex` is not access control. A real client indexing change requires an explicit host value and reviewed rebuild/deploy.

Both consumers must build statically without a live API, database, SMS, map, or media provider. No guest member, phone, PIN, bearer, session, RSVP, message, operational fixture, credential, or server infrastructure value may be serialized into editorial HTML, metadata, public assets, or committed browser evidence. Runtime feature islands may receive public origins/site IDs, but operational data is fetched after hydration under the existing feature contracts.

## Demonstrated reuse

`apps/wedding-demo` is the polished default-preset consumer and owns the Marina & Caio copy, venue, SEO, navigation, feature placement, monogram, and final fictional-demo media. It is not a source of template defaults.

The demo renders the guest-access and mural islands with host-owned static fallback copy until their React clients are available. If scripts fail or are disabled, neither region claims to be loading indefinitely and no runtime data is serialized into the page.

`apps/template-fixture` is a private technical consumer, not a second product demo or permanent environment. It owns the distinct Casa Aurora content/media/SEO, reorders story before hero, inserts a local section through `after-main`, and provides an additional `/hospedagem` route using `WeddingLayout` and `TemplateSection`. It has no guest API, database, SMS, or admin feature.

Both consumers import only `/v1`, build independently, and own their routes and assets. Reuse is proven by shared rendering with different host data, not by copying template files.

## Listening

The contract freezes a small data-and-composition surface instead of a page-builder registry. The five theme variables permit controlled visual adaptation while keeping private classes replaceable. Host ownership of all copy, introduction labels, and assets prevents one couple's content from leaking into another site. The introduction derives its images from gallery and hero contracts instead of creating a second media registry. Lenis remains an internal enhancement because smooth scrolling is presentation behavior, while native anchors, native touch, and reduced-motion fallbacks preserve direct access. The fictional-demo photos/video are approved locally; provider/model/cost traceability, real-client rights, logo approval, production media performance, and launch approval remain separate gates.
