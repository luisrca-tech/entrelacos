# Entrelaços narrative landing

Standalone static Astro app: `@entrelacos/landing`, default development port 4323.
The page presents the product independently from the illustrative weddings.
The canonical integration preview currently uses port 4324 while Frame's earlier
worktree preview occupies 4323.

## Development and validation

Use Ubuntu Node 24 and Bun 1.3.14 from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/landing dev
bun run --cwd apps/landing typecheck
bun run test apps/landing/src scripts/landingIntegration.test.ts
```

Production builds require public destinations:

```sh
PUBLIC_SITE_URL=https://entrelacos.entrelacos.workers.dev/ \
PUBLIC_BOTANICAL_DEMO_URL=https://demo.entrelacos.workers.dev/ \
PUBLIC_LETTERS_DEMO_URL=https://demo-cartas.entrelacos.workers.dev/ \
bun run --cwd apps/landing build
bun run check:public-builds
```

These are prepared destinations, not publication evidence. Development defaults
are localhost ports 4323, 4321 and 4322. Optional `PUBLIC_CONTACT_URL` accepts a
verified HTTPS commercial destination. Without it, conversion buttons link to the
models and ask visitors to reply to the person who shared the page. No phone or
sales email is inferred from account credentials.

Production builds reject missing, invalid, credential-bearing or loopback URLs.
Demo URLs must differ. No database, payment, Cloudflare or authentication secrets
belong in this app. Turbo tracks all four public destination variables.

The static Worker configurations prepare `entrelacos` and `entrelacos-dev`.
The deployment coordinator must select the verified EntreLaços account explicitly.
The public artifact gate includes this app and both independent demos.

## Story and motion

The encounter joins two original CSS 3D gold bands. That shared thread introduces
a visual identity, the people invited, shared plans and the Dashboard that
organizes the details. Abstract botanical and letter compositions introduce the
two demo links. Wedding names, dates and couple photographs remain in the demos.
Guest-management and mural diagrams have no invented customer identity and are
explicitly illustrative.

Lenis 1.3.26 matches the existing Botanical version. It smooths wheel input with
lerp 0.085 and wheel multiplier 0.85, preserves touch scrolling and internal anchors,
and is destroyed when the visitor pauses animations or requests reduced motion.
Sections reveal once with 650ms transitions and a maximum 160ms group stagger.
The introductory bands meet over 1.6 seconds; no overlay, timeout or scroll lock
blocks access to the content. Shorter chapter spacing reduces page length.

Core content and links remain server-rendered and visible without JavaScript or
IntersectionObserver. Native FAQ controls, skip navigation and visible keyboard
focus remain available. No analytics, lead submission, payment initiation or
embedded remote demo runs on this page.

## Assets

The hero, model previews and gift box use original repository-native CSS/SVG
geometry, with system fonts and no external imagery. `public/favicon.svg` is
Frame's original loop mark. `public/social-card.png` is original vector artwork
rasterized to 1200 x 630, depicting gold bands and the general product headline.
The superseded couple photographs remain only in the demos and the original
isolated worktree; they are not shipped by this app.

## Evidence and limits

`work/showcaseIntegrationReport.md` records the integration hashes, tests,
Cloudflare read-only inventory, rollback references and prepared deployment
commands. HTTP/build checks do not establish rendered desktop/mobile appearance,
animation quality or real keyboard acceptance. Those checks remain independent
QA work before launch. No public URL is claimed as newly deployed.

Primary implementation references: the official Lenis repository and Cloudflare
Wrangler authentication-profile, configuration and environment-variable docs.

## Listening

The user asked for a stronger general introduction without the fictional couple.
The revised opening uses an encounter between bands, followed by the identities,
guests, shared plans and organization. CSS 3D avoids another rendering engine;
the existing pinned Lenis version handles smooth scrolling. Personal wedding
examples stay in the separate demos. Contact remains configurable rather than
invented. Independent visual QA and the reviewed production release remain open.

## Editorial structure

The landing has seven main sections: introduction, models, guest organization and mural, gifts, preparation, FAQ, and the final action. The model links consistently name the demonstration, and operational copy uses "painel do casal". The existing `experiencia` and `dashboard` anchors remain on the combined guest section for inbound links. Contact actions still require the configured, verified `PUBLIC_CONTACT_URL`; no destination is invented.

### Listening

The product story now explains the managed setup in the opening. Repeated feature cards and the second introduction were removed; the existing rings, abstract model covers and gift illustration retain the brand's visual identity. Wedding photographs remain in the separate demos.
