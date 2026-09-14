# Block 6 media register

Status: provisional fallback inventory only. No asset in this register is approved as final client media. No AI image/video provider, external media account, cost ceiling, final logo, fictional-couple set, rights package, or production delivery has been approved or used.

## Repository assets

All listed files are owned by their host app, not `packages/template-root`. They are local abstract SVG implementation fixtures with no third-party source or provider call recorded in this task. Their continued use as final public media, trademark/logo approval, and client-facing usage permission remain pending.

| File | Host | Current use | Intrinsic viewBox | Status |
| --- | --- | --- | --- | --- |
| `apps/wedding-demo/public/marina-caio-hero-placeholder.svg` | `wedding-demo` | Hero image and current social-image target | `1800x1200` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-story-encounter-placeholder.svg` | `wedding-demo` | First story entry | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-story-first-trip-placeholder.svg` | `wedding-demo` | Second story entry | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-story-home-placeholder.svg` | `wedding-demo` | Third story entry | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-story-celebration-placeholder.svg` | `wedding-demo` | Fourth story entry | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-one-placeholder.svg` | `wedding-demo` | First gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-two-placeholder.svg` | `wedding-demo` | Second gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-three-placeholder.svg` | `wedding-demo` | Third gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-four-placeholder.svg` | `wedding-demo` | Fourth gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-five-placeholder.svg` | `wedding-demo` | Fifth gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-gallery-six-placeholder.svg` | `wedding-demo` | Sixth gallery item | `1200x900` | Provisional abstract placeholder; replace or explicitly approve |
| `apps/wedding-demo/public/marina-caio-monogram.svg` | `wedding-demo` | Current demo favicon/identity mark | `64x64` | Provisional monogram; not final logo or brand approval |
| `apps/template-fixture/public/fixture-hero.svg` | `template-fixture` | Technical fixture hero | `1600x1000` | Permanent test fixture is acceptable; not client/product media |

The demo passes explicit rendered dimensions matching these viewBox proportions. The fixture does the same for its hero. The hero is reserved for the principal ensaio media; the six-item gallery is reserved for the pre-wedding collection. The optional demo introduction reuses these six gallery assets and ends with the hero asset; it creates no additional media ownership surface. The current demo has no bitmap photo, fictional human depiction, audio, or video file.

## External visual dependency

The demo host supplies a Google Maps iframe URL for Casablanca Eventos, a Google Maps directions URL, and the venue contact page as fallback. The iframe needs no repository API key, but its rendering, terms, privacy behavior, network availability, and venue accuracy remain external review items. The visible address and fallback links remain available without iframe rendering.

The map is not a repository media asset, and a successful local iframe render is not evidence of provider availability, account status, usage rights, legal/privacy approval, or production readiness.

## Final image gate

Before any provisional demo asset becomes an approved final asset, record:

- final file and retained source identity;
- creator/source/provider and generation method;
- input/reference rights and output usage permission;
- restrictions, attribution, territory, duration, and client approval owner/date;
- provider account owner, access status, and actual cost or approved ceiling;
- intended section, crop/focal point, intrinsic dimensions, responsive outputs, format, and file size;
- meaningful alt text or explicit decorative treatment;
- visual review at all agreed viewports and measured layout/performance evidence;
- confirmation that generated people do not imply a real couple or real venue unless explicitly authorized.

No item currently satisfies this final gate.

## Future AI video gate

AI video is a later optional replacement, not part of the current demo build. Before generation or integration, approve and record:

1. provider/tool, account owner, credentials boundary, region/access, terms, and cost ceiling;
2. reference-image rights, fictional-couple consistency requirements, prompt/seed provenance where retainable, and output usage permission;
3. duration, crop, resolution, codec/container, bitrate/file-size budget, and mobile delivery plan;
4. a separately approved poster derived from an authorized source;
5. muted inline loop behavior, no autoplay dependency, native static fallback, reduced-motion behavior, failure behavior, and performance measurements;
6. final human approval of content, identity consistency, artifacts, accessibility text, and venue claims.

The template's `VideoMedia` contract already requires `src`, `poster`, `alt`, `width`, and `height` and renders muted, looped, inline, and without autoplay. That code capability is not evidence that any video, provider workflow, rights, cost, or final poster has been approved.

## Prohibited promotion into shared code

Do not move any host asset, couple identity, venue, alt text, media URL, poster, or approval record into `packages/template-root`. The shared package may retain rendering behavior and validators only. A new host must provide its own media register and content values.

## Listening

The register keeps lightweight SVGs so layout, crops, fallbacks, metadata, and reuse can be tested before media production. It separates technical readiness from content approval: working image/video markup does not settle likeness rights, provider terms, costs, client approval, or launch performance. The later AI-video option therefore remains reversible and cannot silently replace the current image-led fallback.
