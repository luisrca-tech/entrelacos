# `@entrelacos/template-root`

Reusable public-site presentation package. The versioned `@entrelacos/template-root/v1` entrypoint exposes:

- `WeddingLayout`, `WeddingHome`, `HeroSection`, `StorySection`, `GallerySection`, `ScheduleSection`, `VenueSection`, `DetailsSection`, and `TemplateSection`;
- independent serializable contracts for site identity, page SEO, navigation, footer, media, section content, gallery items, schedule entries, practical guidance, and venue/map data;
- trust-boundary validators for URLs, approved Google Maps embed/directions forms, metadata, media dimensions, section IDs, and serializable values.

`HeroContent` accepts an optional host-owned `action` link and optional host-owned introduction labels. In `WeddingHome`, enabling the introduction requires gallery content: the template reuses those gallery frames and finishes with the hero frame instead of asking the host to duplicate media configuration. During the final handoff, the canonical hero media is already visible beneath the fading intro; only after that layer is removed do the header and masked hero copy enter. Image media renders eagerly with supplied dimensions; video media requires a poster and renders muted, inline, and loop-ready without depending on autoplay. Reduced motion skips the introduction.

`StoryContent` keeps one short host-owned story paired with a background media asset. The section renders a full-bleed image or video with a readable text overlay. An optional `sequence` of stills may follow an image background and crossfades automatically while the section is in view; additional couple photos still belong in `GalleryContent`. Reduced motion keeps the first still. The media uses the same supplied dimensions and poster fallback contract as hero media.

`GalleryContent` keeps every supplied image or video in document order and presents one full item per Embla carousel index. Host-owned previous, next, expand, and close labels drive the controls. Hover or keyboard focus reveals the expand action, which opens the same collection in a full-screen Base UI dialog. Before React hydrates, the canonical media remains available as a horizontal-scroll fallback and never becomes a direct file link. `ScheduleContent` renders host-owned entries and practical guidance. A guidance item may open an optional host-owned image and note in a dialog. `VenueContent` renders a manually supplied Google Maps embed URL, a selectable address fallback, safe directions/contact links, and an optional clipboard enhancement with host-owned feedback labels. `FooterContent` requires host-owned names, date, links, RSVP, year, copyright, and attribution.

The host supplies every visible label, title, description, URL, SEO value, media asset, section ID, route, and local extension. The package contains no wedding-specific editorial defaults and never reads an API, database, environment secret, session, or provider.

The default desktop composition uses most of the available width for editorial imagery. Its proportional scale grows from a 1440px base through a 1920px cap, then keeps the stage centered instead of stretching across 2K/4K displays. The main gallery frame uses a shorter `16 / 10` desktop ratio and returns to `4 / 3` on mobile. Both desktop and mobile heroes occupy `100svh`; layouts become single-column at the existing 960px breakpoint.

`WeddingHome` sets the optional `hasHero` layout hint only when the hero is the first rendered section. Runtime navigation becomes transparent only while the fixed header overlaps the hero, including in reordered compositions. Consumers using `WeddingLayout` directly may set `hasHero` to `true` only when the page starts with a `HeroSection`; it defaults to a solid, legible navigation state. `TemplateSection` accepts `headingLevel={1}` for a standalone page title and otherwise renders its title at level 2.

```astro
---
import { TemplateSection, WeddingLayout } from "@entrelacos/template-root/v1";
---

<WeddingLayout locale="pt-BR" site={site} seo={seo} navigation={navigation} footer={footer}>
  <TemplateSection content={sectionContent} />
</WeddingLayout>
```

The public layout has a deliberately small slot surface: `head`, `header-addon`, `before-main`, `after-main`, `admin-access`, and `footer-addon`. Routes and local sections remain Astro files in the host app; this package is not a CMS, page builder, registry, or router.

Only `/v1` is public. Layout and section source files remain internal implementation details used by that entrypoint.

## Gift presentation seam

`GiftSection` accepts validated host-owned `SectionContent` and a runtime slot. It starts hidden and exposes `data-gift-section`; the composed `GiftRegistry` from `@entrelacos/wedding-features` reveals that nearest surface only after an eligible public catalog is returned. The template does not fetch data, evaluate receiving readiness, create payments or hold secrets. Hosts mount the runtime with `client:only="react"` inside the `after-main` slot. Catalog errors or ineligibility keep the surface hidden; pending checkout recovery may remain visible without claiming payment receipt.

## Listening

The new seam preserves the presentation/runtime split. A hidden initial surface avoids showing an empty gift section before server eligibility is known. Static host content and template tokens remain editable independently of the operational catalog.

The green template adapts the approved New Era Capital Rebrand motion from `src/utils/homeMotion.ts`, `homeStory.ts`, `homeSmoothScroll.ts`, and their entrance components. Headings rise through measured line masks over 1.2 seconds, with 180 milliseconds between lines and the reference `cubic-bezier(0.33, 0.05, 0.2, 1)` curve. Labels fade over 0.6 seconds; body copy takes 1 second after the heading's 1.4-second reading beat. Complete groups rise 8 pixels over 1.05 seconds, and cards rise 16 pixels over 1.4 seconds. Images open downward over 1.4 seconds with the reference's separate curtain and scale curves. The wedding template keeps its own content and layout rather than adopting the reference's pinned investment scenes.

The six-frame introduction omits one gallery image only during the opening and keeps the hero last. It finishes in 4.85 seconds, with at most 150 milliseconds reserved for media readiness; larger collections share a bounded stagger budget. The complete gallery remains available. Observers target stable, unclipped wrappers at 15% visibility with a 10%-of-viewport-height bottom inset, with reachable thresholds for tall content. Newly mounted gift and mural cards are observed independently, and their short cascades reset per responsive row. Keyboard focus and page-end safeguards reveal content immediately. Replaying completed entrances on every scroll was rejected to keep reading calm. Story frames crossfade without restarting a zoom on each image.

Section spacing, gallery controls, gift cards, guest access, and the message mural share softer shapes and visible keyboard focus. Lenis uses the reference's `lerp: 0.07` and `wheelMultiplier: 0.65`, with 1.15-second anchor navigation accounting for the fixed header. Touch remains native, while the introduction and open dialogs pause page smoothing and preserve nested scrolling. Server-rendered content remains visible without JavaScript; reduced-motion preferences bypass the introduction, smoothing, and reveal movement. Failed line measurement or animation restores the original heading. Gift eligibility, payments, invitation authentication, RSVP submission, and public message moderation retain their existing behavior. The local demo uses the development API; production content and payment readiness require separate validation before release.
