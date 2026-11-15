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
PUBLIC_SITE_URL=https://entrelacosbr.site/ \
PUBLIC_BOTANICAL_DEMO_URL=https://demo-botanico.entrelacosbr.site/ \
PUBLIC_LETTERS_DEMO_URL=https://demo-cartas.entrelacosbr.site/ \
bun run --cwd apps/landing build
bun run check:public-builds
```

These are prepared destinations, not publication evidence. Development defaults
are localhost ports 4323, 4321 and 4322. The contact buttons open the approved
Entrelaços WhatsApp number with a prefilled message. Set `PUBLIC_CONTACT_URL` to
override that link with a verified HTTPS contact destination.

Production builds reject missing, invalid, credential-bearing or loopback URLs.
Demo URLs must differ. No database, payment, Cloudflare or authentication secrets
belong in this app. Turbo tracks all four public destination variables.

The static Worker configurations prepare `entrelacos` and `entrelacos-dev`.
The deployment coordinator must select the verified EntreLaços account explicitly.
The public artifact gate includes this app and both independent demos.

Set the Cloudflare Workers Builds root directory to the repository root (`/`)
for production builds and branch previews. Use the build command for the
target Worker so the artifact gets the correct canonical and demo URLs.

| Worker | Production branch | Build command |
| --- | --- | --- |
| `entrelacos` | `main` | `bun scripts/buildShowcase.ts landing production` |
| `entrelacos-dev` | `development` | `bun scripts/buildShowcase.ts landing development` |

For a branch preview, run
`node apps/landing/node_modules/wrangler/bin/wrangler.js preview --config apps/landing/wrangler.jsonc`.
Append `--env dev` for `entrelacos-dev`. Existing previews keep their own
settings, so check them individually after a change to the preview defaults.

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
focus remain available. No lead submission, payment initiation or embedded
remote demo runs on this page. Optional, consent-gated measurement is described
below.

## Medição de anúncios (Meta Pixel e GA4)

A landing (e só ela: nunca os sites dos casais, os demos ou o admin) pode
carregar o Meta Pixel, que cobre Instagram e Facebook, e o Google Analytics 4.
Tudo fica em `src/landingTracking.ts` e `src/components/LandingTracking.astro`,
incluído em `index.astro` e `duvidas.astro`.

| Variável | Formato | Efeito quando vazia |
| --- | --- | --- |
| `PUBLIC_META_PIXEL_ID` | só dígitos, ex.: `123456789012345` | Meta Pixel não carrega |
| `PUBLIC_GA4_MEASUREMENT_ID` | `G-XXXXXXX` | GA4 não carrega |

As duas são opcionais e não entram em `landingConfig`: sem nenhuma delas, a
página não mostra o aviso de cookies nem carrega script de terceiros. Um valor
preenchido com formato inválido falha o build, para não publicar um ID com erro
de digitação. Os IDs são públicos por natureza, mas não devem ser commitados.

### Onde configurar no Cloudflare

Os valores são lidos no build (o Astro embute variáveis `PUBLIC_*` no HTML),
então são **variáveis de build**, não `vars` do `wrangler.jsonc`. No painel:
Workers & Pages → Worker → Settings → Build → Variables and secrets.

- Produção: Worker `entrelacos` (branch `main`).
- Desenvolvimento: Worker `entrelacos-dev` (`env.dev`, branch `development`).
  Use um pixel/stream de teste ou o mesmo ID, sabendo que o tráfego de
  `dev.entrelacosbr.site` entra nos relatórios.

Depois de alterar uma variável, dispare um novo build. Para builds locais ou
`wrangler preview`, exporte as variáveis antes de
`bun scripts/buildShowcase.ts landing <ambiente>`; o Turbo já as inclui na
chave de cache.

### Consentimento (LGPD)

O aviso aparece no rodapé da janela só quando há pelo menos um ID. Meta e GA4
carregam apenas depois de "Aceitar"; "Recusar" não carrega nada. A escolha fica
em `localStorage` (`entrelacos-tracking-consent`). Para rever o aviso, apague
essa chave nas ferramentas do navegador. Ainda não há página de política de
privacidade; quando existir, inclua o link no aviso.

### Eventos

| Interação | Meta Pixel | GA4 | `content_name` |
| --- | --- | --- | --- |
| Carregar a página | `fbq('track', 'PageView')` | `page_view` (via `gtag('config', id)`) | — |
| Link para o Botânico | `fbq('track', 'ViewContent', …)` | `gtag('event', 'view_demo', …)` | `Cinema Botânico` |
| Link para as Cartas ou o mural | `fbq('track', 'ViewContent', …)` | `gtag('event', 'view_demo', …)` | `Cartas do Nosso Sim` |
| Link de contato (WhatsApp) | `fbq('track', 'Contact', …)` | `gtag('event', 'contact_whatsapp', …)` | `cabecalho`, `menu`, `inicio`, `fechamento` ou `duvidas` |

A posição vem do atributo `data-track-position` mais próximo do link. O evento é
registrado na fase de captura do clique, sem `preventDefault`, então a navegação
não espera a rede; o envio depende do próprio `fbevents.js`/`gtag.js`. Marque
`Contact` como conversão no Gerenciador de Eventos e `contact_whatsapp` como
evento principal no GA4.

### Origem do anúncio no WhatsApp

Se a URL de entrada tiver `utm_source`, `utm_campaign` ou `fbclid`, os links
`wa.me` ganham um código no fim da mensagem pré-preenchida, ex.:
`(ref: ig-noivas-2027)`. `instagram`/`ig` vira `ig`, `facebook`/`fb` vira `fb`,
só `fbclid` vira `meta`, e o nome da campanha é normalizado (minúsculas, sem
acento, até 40 caracteres). O código vale para a aba inteira (`sessionStorage`),
inclusive em `/duvidas`. Sem esses parâmetros a mensagem fica idêntica. Isso
independe do consentimento: o texto é visível ao visitante antes de enviar.

Padrão sugerido para os anúncios:

```text
utm_source=instagram&utm_medium=paid&utm_campaign=<nome>
utm_source=facebook&utm_medium=paid&utm_campaign=<nome>
```

No Gerenciador de Anúncios também funciona
`utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}`
(`ig` e `fb` são reconhecidos).

### Como testar

1. Faça o build com IDs de teste e sirva `dist`, ou use o ambiente dev.
2. Meta: com a extensão Meta Pixel Helper, aceite o aviso e confira `PageView`,
   depois clique em um demo (`ViewContent`) e no WhatsApp (`Contact`). No
   Gerenciador de Eventos → fonte de dados → "Testar eventos", informe a URL e
   veja os eventos chegando com `content_name`.
3. GA4: abra a página pelo Tag Assistant (tagassistant.google.com), que ativa o
   modo de depuração, e acompanhe em Administrador → DebugView os eventos
   `page_view`, `view_demo` e `contact_whatsapp`.
4. Recuse o aviso em outra janela anônima e confirme na aba Rede que nenhuma
   requisição a `connect.facebook.net` ou `googletagmanager.com` acontece.
5. Abra `/?utm_source=instagram&utm_campaign=teste` e passe o mouse no botão de
   WhatsApp: a mensagem termina com `(ref: ig-teste)`.

Próximo passo: a API de Conversões (CAPI) da Meta, enviando `Contact` pelo
servidor para reduzir a perda por bloqueadores. Não faz parte desta entrega.

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
examples stay in the separate demos. Independent visual QA and the reviewed
production release remain open.

## Editorial structure

The landing has seven main sections: introduction, models, guest organization and mural, gifts, preparation, FAQ, and the final action. The model links consistently name the demonstration, and operational copy uses "painel do casal". The existing `experiencia` and `dashboard` anchors remain on the combined guest section for inbound links. The WhatsApp contact appears in the desktop header, the mobile menu, the introduction, and the closing section.

### Listening

The product story now explains the managed setup in the opening. Repeated feature cards and the second introduction were removed; the existing rings, abstract model covers and gift illustration retain the brand's visual identity. Wedding photographs remain in the separate demos.
