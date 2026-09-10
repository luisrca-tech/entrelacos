# EntreLaços Design References

## Purpose

This document records visual and motion references for the first EntreLaços wedding-site template. It complements the product guide without defining the final art direction, component library, or motion implementation.

The references should be used for composition, pacing, hierarchy, and interaction vocabulary. Their real-estate branding, copy, and layouts should not be copied literally.

## Reference family

The four sites form a coherent reference family rather than four unrelated market signals. They share an editorial visual language and identify O’Kane Marketing in their footers.

- [The Bellevue](https://www.thebellevueboston.com/)
- [The Arlow](https://www.arlowroslindale.com/)
- [63 West](https://www.63weststreet.com/)
- [One Hudson](https://www.liveonehudson.com/)

Common traits observed across this family:

- large editorial serif typography paired with restrained sans-serif navigation;
- full-bleed photography and cinematic media moments;
- asymmetrical image-and-copy compositions;
- generous whitespace used as part of the narrative rhythm;
- fixed or sticky navigation that changes treatment while scrolling;
- content entrances based on opacity, translation, masks, and staggered text;
- long-form sections driven by scroll progress;
- subtle image scaling and underline transitions on hover;
- restrained color systems that let photography carry the emotional tone;
- motion concentrated at section transitions instead of constant decorative movement.

## The Bellevue

URL: https://www.thebellevueboston.com/

### Relevant patterns

- Oversized serif headline layered over a full-bleed hero image.
- Small supporting labels and a detached promotional card create scale contrast.
- Fixed header remains visually present while the page moves beneath it.
- Text is split into individual characters in at least one editorial statement, enabling progressive character or word reveals.
- Horizontal image galleries use previous/next controls and a compact progress indicator.
- Images receive subtle scale treatment on hover.
- Large neutral sections give animated typography and photography room to breathe.

### Possible EntreLaços translation

- Couple names and wedding date as the oversized hero statement.
- A detached card for RSVP or ceremony details.
- A character- or line-based reveal for one short emotional statement only.
- A controlled horizontal gallery for the couple’s story or photographs.

### Caution

The promotional modal and persistent banner belong to a commercial property funnel. They are not references for the wedding template.

## The Arlow

URL: https://www.arlowroslindale.com/

### Relevant patterns

- Full-viewport hero with centered typography over architectural imagery.
- Header changes from a transparent hero treatment to a solid light surface while scrolling.
- Alternating editorial sections pair large images with concise text blocks.
- Desktop sections use sticky positioning to hold visual context while adjacent content moves.
- Images use restrained hover zoom.
- Video acts as a narrative interval rather than permanent background decoration.
- Amenity labels create a quiet typographic grid before larger content blocks.

### Possible EntreLaços translation

- Full-height opening with names, date, and city.
- Alternating sections for ceremony, reception, dress code, and location.
- Sticky photography for the couple’s story on desktop, with a normal vertical flow on mobile.
- A short optional video moment when the couple provides suitable media.

### Caution

The page uses extensive vertical spacing. The wedding template should retain the calm pacing without making RSVP and practical information feel distant.

## 63 West

URL: https://www.63weststreet.com/

### Relevant patterns

- Cinematic hero using large moving media with compact text anchored near the lower edge.
- Editorial introduction built from strong scale contrast and paired images.
- Full-screen visual chapters combine background imagery, overlay copy, calls to action, and section counters.
- Sticky sequences create controlled image changes as the visitor advances through the story.
- Long empty intervals intentionally slow the narrative and build anticipation.
- Navigation stays fixed and maintains a strong relationship with the page’s changing backgrounds.
- Smooth scrolling is present in the current implementation.

### Possible EntreLaços translation

- A single cinematic hero, using photo or muted video depending on available assets.
- One scroll-driven gallery chapter for the couple’s story.
- Section counters could become dates, story milestones, or ceremony/reception stages.
- Overlay text can introduce meaningful moments without turning every section into a card.

### Caution

This is the most technically and editorially demanding reference. The first template should borrow one strong sticky narrative sequence, not reproduce its entire page length or every transition.

## One Hudson

URL: https://www.liveonehudson.com/

### Relevant patterns

- Fixed navigation changes color and background according to the active section.
- The page contains an explicit transition stage and multiple scroll-driven chapters.
- Large statements are layered over full-screen natural imagery.
- Sticky media reveals move content into place over an extended scroll distance.
- Content cards use subtle hover scaling and sibling-opacity treatment.
- The cream, olive, and warm photographic palette creates a calm, tactile atmosphere.
- Reduced-motion utility classes are present in interactive card treatments.
- Smooth scrolling is present in the current implementation.

### Possible EntreLaços translation

- Header theme changes between the hero, light information sections, and dark or photographic sections.
- A full-screen emotional statement can bridge the story and practical wedding information.
- Nature-inspired palettes work well for outdoor, countryside, and destination weddings.
- Card hover behavior can support accommodation, nearby places, or wedding guidance without dominating the experience.

### Caution

Scroll-driven reveals must preserve reading order and remain understandable when motion is disabled.

## Motion vocabulary for the first template

The references support the following candidate vocabulary. Exact timings and implementation remain design decisions.

### Page entrance

- Hero image or video resolves from a subtle scale or mask.
- Couple names enter by line or word.
- Date and location follow with a short stagger.
- Navigation appears last, without delaying access to the page.

### Section entrance

- Copy uses short fade-and-translate reveals.
- Images use masks, clipping, or gentle scale resolution.
- Staggers are reserved for compact groups such as dates, family names, or gallery items.

### Scroll narrative

- At most one major sticky storytelling sequence in the first template.
- Scroll progress may reveal photographs, story milestones, or venue moments.
- Practical sections such as RSVP, schedules, maps, and contact information remain direct and stable.

### Hover and focus

- Images scale subtly inside an overflow-hidden frame.
- Links use understated underline or opacity transitions.
- Buttons retain clear focus states and immediate feedback.

### Page transitions

- Optional crossfade or curtain transition between public pages if the final site is not a single landing page.
- No transition may delay RSVP, authentication, or form feedback.

## Implementation guardrails

- Reproduce the motion behavior, not the source sites’ framework or code.
- Do not require GSAP, Lenis, or a large animation runtime before the final motion specification proves the need.
- Prefer CSS transitions and Intersection Observer for simple entrances.
- Evaluate Motion for orchestrated sequences only when it materially simplifies the implementation.
- Preserve meaningful HTML and reading order before JavaScript executes.
- Respect `prefers-reduced-motion` across every animated component.
- Reduced-motion mode must remove parallax, sticky choreography, smooth scrolling, and large transforms while preserving all content.
- Avoid layout shifts caused by late media or animation initialization.
- Autoplay video must be muted, optional, poster-backed, and replaced by an image when appropriate for performance or accessibility.
- Mobile should use shorter movement distances and simpler vertical flows.
- RSVP, OTP, errors, and confirmations require fast functional feedback rather than cinematic motion.

## Design questions still open

- Which visual direction should define the first template: editorial classic, botanical contemporary, minimalist luxury, or another direction?
- Will the first public experience be one long landing page or a small set of pages?
- Which sections deserve cinematic treatment, and which must remain purely practical?
- Will the default hero use a photograph, muted video, or support both?
- Should the main story use a sticky scroll sequence, a timeline, or an editorial alternating layout?
- How much typography may change between client designs while the motion system stays consistent?
- Which motion tokens should be shared across templates?
- What are the mobile and reduced-motion equivalents for every signature interaction?

## Current conclusion

The first EntreLaços template should feel editorial, cinematic, calm, and contemporary. Its motion should guide attention and pace the couple’s story. The strongest reusable combination from these references is:

1. an image-led hero with a restrained entrance sequence;
2. a transparent-to-solid header transition;
3. alternating editorial image and text sections;
4. one signature sticky storytelling moment;
5. a compact photo gallery with subtle controls;
6. direct, low-motion practical sections for schedule, location, RSVP, and messages.

This is a reference direction, not final design approval.
