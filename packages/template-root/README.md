# `@entrelacos/template-root`

Reusable public-site presentation package. The versioned `@entrelacos/template-root/v1` entrypoint exposes:

- `WeddingLayout`, `WeddingHome`, `HeroSection`, `StorySection`, `GallerySection`, `ScheduleSection`, `VenueSection`, `DetailsSection`, and `TemplateSection`;
- independent serializable contracts for site identity, page SEO, navigation, footer, media, section content, gallery items, schedule entries, practical guidance, and venue/map data;
- trust-boundary validators for URLs, approved Google Maps embed/directions forms, metadata, media dimensions, section IDs, and serializable values.

`HeroContent` accepts an optional host-owned `action` link. Image media renders eagerly with supplied dimensions; video media requires a poster and renders muted, inline, and loop-ready without depending on autoplay.

`StoryContent` requires at least two host-owned `StoryEntry` values. Entries keep text and media paired in document order. On wider screens, an optional progressive-enhancement stage presents one supplied media at a time with a single sticky visual; the canonical entry media remains the no-JavaScript, mobile, and reduced-motion fallback. Story media uses the same supplied dimensions and poster fallback contract as hero media.

`GalleryContent` keeps every supplied image or video in document order and presents one full item per Embla carousel index. Host-owned previous, next, expand, and close labels drive the controls. Hover or keyboard focus reveals the expand action, which opens the same collection in a full-screen Base UI dialog. Before React hydrates, the canonical media remains available as a horizontal-scroll fallback and never becomes a direct file link. `ScheduleContent` renders host-owned entries and practical guidance. `VenueContent` renders a manually supplied Google Maps embed URL, a selectable address fallback, safe directions/contact links, and an optional clipboard enhancement with host-owned feedback labels. `FooterContent` requires host-owned names, date, links, RSVP, year, copyright, and attribution.

The host supplies every visible label, title, description, URL, SEO value, media asset, section ID, route, and local extension. The package contains no wedding-specific editorial defaults and never reads an API, database, environment secret, session, or provider.

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
