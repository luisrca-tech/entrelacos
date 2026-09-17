# Block 6 media register

Status: the final fictional-couple image set, hero poster, and hero video were approved by the project owner for the local `wedding-demo` on 2026-09-14. This approval does not cover a real client, production launch, final logo/monogram, Google Maps privacy review, or broader commercial reuse.

## Source and approval record

- The still-image set was generated through an OpenAI image-generation workflow for this fictional demo. The exact image model identifier was not retained.
- The hero video was generated and refined in Google Flow from the approved fictional-couple visual reference. The exact Flow video-model identifier was not retained.
- Retained operator source files are the eleven `*-source.png` images, `marina-caio-couple-reference.png`, `marina-caio-video-start-frame-source.png`, and `Couple_walking_in_natural_landscape_20260914013913.mp4`. Source files remain outside the repository; only delivery assets are versioned.
- The project owner approved the resulting fictional identities, stills, and completed video for use in the Marina & Caio demo in this conversation on 2026-09-14.
- No real couple or real client likeness is claimed. Provider output terms still govern the generated media. Exact per-asset cost and a separate production cost ceiling were not supplied because generation used the owner's existing accounts; future client or commercial reuse must record them independently.
- No provider credential, account token, prompt history, or private reference path is stored in the repository or static build.

## Repository assets

All files are owned by their host app, not `packages/template-root`.

| File | Current use | Intrinsic size | Delivery size | Status |
| --- | --- | --- | --- | --- |
| `apps/wedding-demo/public/marina-caio-hero.mp4` | Hero background loop | `1920x1080`, 8 seconds, H.264 | 6.8 MiB | Approved fictional-demo video; audio stream removed |
| `apps/wedding-demo/public/marina-caio-hero-poster.webp` | Hero poster, fallback, and intro ending | `1920x1080` | 182 KiB | Exact first decoded frame of the approved hero video |
| `apps/wedding-demo/public/marina-caio-hero.webp` | Social image | `1536x1024` | 348 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-story-encounter.webp` | História background, first still | `1448x1086` | 196 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-story-first-trip.webp` | Retained story alternate | `1448x1086` | 294 KiB | Approved fictional-demo image; not in the compact sequence |
| `apps/wedding-demo/public/marina-caio-story-home.webp` | História sequence still | `1448x1086` | 197 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-story-celebration.webp` | História sequence still | `1448x1086` | 162 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-one.webp` | First gallery item | `1448x1086` | 312 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-two.webp` | Second gallery item | `1448x1086` | 353 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-three.webp` | Third gallery item | `1448x1086` | 192 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-four.webp` | Fourth gallery item | `1448x1086` | 190 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-five.webp` | Fifth gallery item | `1448x1086` | 277 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-gallery-six.webp` | Sixth gallery item | `1448x1086` | 168 KiB | Approved fictional-demo image |
| `apps/wedding-demo/public/marina-caio-monogram.svg` | Demo favicon/identity mark | `64x64` | Lightweight SVG | Provisional monogram; not final logo or brand approval |
| `apps/template-fixture/public/fixture-hero.svg` | Technical fixture hero | `1600x1000` | Lightweight SVG | Permanent test fixture; not client/product media |

The optimized WebP delivery set totals approximately 2.7 MiB. The original PNG files are intentionally not duplicated in the repository. The demo supplies exact intrinsic dimensions and meaningful Portuguese alt text from host-owned content.

## Hero video behavior

The hero uses the approved MP4 as a muted, autoplaying, inline, continuous loop with a WebP poster extracted from its exact first decoded frame. The repository copy physically contains no audio stream, so sound cannot be exposed by changing browser volume. The introduction reuses the six gallery images and finishes on that matching poster. While those stills run, the video is loaded to its first decoded frame but remains paused. Playback starts beneath the overlay fade; only after that fade is removed and the browser paints the moving hero do the header and hero copy begin their independent entrances. This preserves the approved continuous fullscreen transition without making video decoding compete with the chrome animations.

At initial `prefers-reduced-motion: reduce`, the introduction is skipped and video playback is paused at the first frame. Preference changes are observed by the hero playback controller. The poster and nested image fallback keep the hero useful if video playback is unavailable.

Local browser validation covered desktop and `390x844` mobile rendering. The video reported `readyState: 4`, played muted and inline, and crossed its 8-second boundary while remaining in the same loop. Handoff instrumentation measured video playback before overlay removal and header/copy animation startup on a later paint, with no long task during that interval. Reduced-motion reload reported `paused: true` and `currentTime: 0`. This is local delivery evidence, not a production Web Vitals, bandwidth, CDN, or device-matrix claim.

## External visual dependency

The demo host supplies a Google Maps iframe URL for Casablanca Eventos, a Google Maps directions URL, and the venue contact page as fallback. The iframe needs no repository API key, but its rendering, terms, privacy behavior, network availability, and venue accuracy remain external review items. The visible address and fallback links remain available without iframe rendering.

## Remaining gates

- Final logo/favicon/monogram and brand approval remain pending.
- Any replacement by real client media requires client authorization, likeness rights, source records, usage restrictions, cost, approved crops, and a new human review.
- Production launch still requires measured loading behavior on representative mobile networks and the normal deployment, privacy, provider, and legal gates.
- Exact generation model identifiers and costs were not retained. They must be recorded before claiming a repeatable commercial media workflow.

## Prohibited promotion into shared code

Do not move any host asset, couple identity, venue, alt text, media URL, poster, or approval record into `packages/template-root`. The shared package owns reusable rendering, validation, autoplay-loop coordination, and reduced-motion behavior only. A new host must provide its own media register and content values.

## Listening

The approved fictional set replaces the abstract demo placeholders without weakening the template/host boundary. Original PNGs remain operator-controlled sources; optimized WebP and silent MP4 files are the smallest complete delivery surface. A real client's media cannot inherit this demo approval.
