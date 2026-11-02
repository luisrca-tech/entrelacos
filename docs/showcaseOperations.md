# Showcase operations

The independent hosts are apps/wedding-demo-botanico and apps/wedding-demo-cartas. Their visual packages are packages/templates/cinema-botanico and packages/templates/cartas-do-nosso-sim. The fixture consumes the Botanical public entrypoint. Each host must be built and deployed separately.

| Host | Database site | Production Worker | Development Worker | Local port |
| --- | --- | --- | --- | --- |
| Cinema Botânico | demo-wedding | demo | demo-dev | 4321 |
| Cartas do Nosso Sim | demo-wedding-cartas | demo-cartas | demo-cartas-dev | 4322 |

The existing Botanical Worker and site identity are preserved. Public Worker origins follow the existing entrelacos.workers.dev convention; a prepared name is not proof that deployment succeeded.

## Reproducible public builds

Run from the repository root with an explicit app and environment:

```sh
bun scripts/buildShowcase.ts botanical development
bun scripts/buildShowcase.ts letters development
bun scripts/buildShowcase.ts landing development
```

Replace `development` with `production` only for a production build. The checked-in public environment map overrides inherited public values and rejects unknown targets. It binds each artifact to its API, site, Dashboard and public origins. The Botanical production build explicitly sets `PUBLIC_LIVE_DEMO_SITE_ID=demo-wedding`, as authorized for this tenant. Development retains sandbox behavior; Letters never receives a live opt-in. This does not change receiving eligibility, financial consent, backend live-site policy, quote or checkout guards.

Cloudflare Builds must use the repository root, not the removed `apps/wedding-demo` directory. For Botanical, use `bun scripts/buildShowcase.ts botanical production` (or `development`) as the build command and `bunx wrangler deploy --config apps/wedding-demo-botanico/wrangler.jsonc --keep-vars` (append `--env dev` for development) as the deploy command. Build-system credentials belong in the service configuration, never in source. Confirm branch and service identity before updating a build trigger.

The requested rename to `demo-botanico` / `demo-botanico-dev` is not yet applied. Preserve the existing URLs until the new origins, tenant admission, build integration and compatibility links are verified together. An authenticated manual publish does not establish permission to edit Workers Builds; the latter currently returns HTTP 403 for the designated profile.

## Controlled data population

The explicitly invoked API script adds illustrative, persistent records. It verifies database identity and the existing demo-wedding identity, uses one transaction and lock, preserves previous operational rows, copies only active, non-revoked management memberships to Letters and registers that site's exact origins. It never creates user accounts, changes authentication credentials, sends invitations, resets datasets, copies guest data across environments, or changes receiving configuration.

From the repository root, using the existing development .env files:

```sh
ENTRELACOS_DATABASE_TARGET=development \
ENTRELACOS_SHOWCASE_CONFIRM='POPULATE development EntreLacos showcases' \
bun run --cwd apps/api showcase:populate
```

Production requires independently supplied production DATABASE_URL, API/media configuration and APP_ENV=production, plus ENTRELACOS_DATABASE_TARGET=production, ENTRELACOS_SHOWCASE_CONFIRM='POPULATE production EntreLacos showcases' and ENTRELACOS_PRODUCTION_SHOWCASE_AUTHORIZED='POPULATE production showcases'. The script refuses a mismatched application environment, real customer site, unrelated showcase identity or conflicting origin. Select and verify production configuration privately; never print credentials or assume development env files contain it.

The deterministic showcase-v1 IDs provide additive idempotency. Dashboard edits to existing example records are preserved. No DELETE statement exists. Sample RSVP confirmations create audit history. Synthetic reserved telephone numbers and explicit example authors prevent impersonating actual invited people. Gift values are illustrative contributions, not retail quotes or promises to deliver physical goods.

Gift photographs are downloaded from the source pages listed in apps/api/src/showcaseData.ts, decoded through the existing image boundary and published immutably to the configured R2 environment. Stored assets include verified dimensions, bytes and object metadata. Image source credits and the current Unsplash license are recorded in docs/showcaseGiftMedia.md.

## Receiving and public verification

Financial accounts, consent, credentials and verification evidence are never cloned. A persisted gift catalog does not grant payment eligibility. The two designated showcases have an explicit server-authorized demonstration catalog when receiving is unavailable. Admission requires the exact site ID, matching repository slug, isDemo=true, the environment-specific public URL above, and an explicitly selected development or production environment. No client flag, arbitrary is_demo row or other tenant receives this exception.

The public catalog page uses mode="demonstration" and returns published items, nominal example prices and finalized same-site images. The UI clearly labels the demonstration and offers no contribution action or payment-method promise. When normal readiness and live-site policy permit the existing Botanical catalog, its sandbox/live behavior remains unchanged.

For active authorized catalog managers, the receiving/readiness response can include a separate, same-site catalogAccess={siteId, mode:"demonstration"} grant. Financial readiness itself is unchanged. The Dashboard uses this grant to open the existing gift editor; catalog mutations retain capability checks, site locks, lifecycle/term checks, media validation and tenant scoping. Photo upload/finalization retains the existing authorization and immutable storage contracts.

Quotes, checkout, financial setup, withdrawal and receiving evidence never consume the demonstration grant. Published gift lookup for quote creation remains strictly readiness-gated, and checkout revalidates the site's own receiving context. Do not copy the Botanical live opt-in to Letters or alter receiving setup to display gifts.

Release requires the API and all clients that parse the changed public contract, including the Dashboard, both demos and fixture. Publish updated clients before the API when staging compatibility matters: new clients accept the old API; old clients reject the new demonstration mode safely. An old cached Dashboard can require a refresh after the API starts returning the optional grant. API rollback restores the previous not-ready catalog block, with no database migration or financial rollback.

Check the public mural and gift endpoints with the exact registered Origin, and use existing authenticated Dashboard contracts to confirm site visibility, management roles, guest reports and catalog ownership. Inspect payment readiness without executing a real payment or withdrawal. HTTP success and static builds do not establish visual or transactional acceptance.

## Listening

Template ownership and demo dataset ownership are independent. Separate visual packages avoid theme switches in Botanical; feature and API authority remains shared. The additive script was chosen instead of the existing reset procedure so real rows, accounts and previous payment activity survive. Catalog demonstration and financial readiness now have separate contracts. Normal financial readiness remains a payment dependency to verify independently, never an inferred consequence of seeding catalog rows.
