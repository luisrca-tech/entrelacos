# Gift pricing responsibility

## Current policy (2026-11-06)

New purchases use `BUYER_GROSS_UP` exclusively. The panel explains this fixed policy rather than asking the couple to select who pays. The compatibility settings endpoint returns the effective buyer policy and rejects attempts to restore recipient deductions. It does not rewrite old quotes or purchase snapshots.

- New and updated nominal gift amounts must be at least R$5.00. Historical smaller gifts remain readable but cannot be published or quoted for a new purchase until their value is corrected.
- Guests see the server-calculated starting price with fees included. A missing price never falls back to the couple's nominal amount. The selected payment method and installments produce a fresh quote before confirmation.
- The couple sees one `Taxas` amount equal to platform commission plus processing. Commission remains the existing rounded 2% of nominal. The installment surcharge is already included in the quoted processing amount and must not be added twice.
- Card purchases offer up to 12 installments, each at least R$5.00, only when the receiving account provides valid corresponding tariff evidence. Pix remains a single payment. Prices use the existing integer-cent gross-up and current account terms; published promotional prices are not embedded in code.
- Exact-count installments use the Asaas payment invoice flow, not hosted checkout's maximum-count selector. The created plan is checked against the immutable quote before redirect. Card details remain with Asaas. Payer name, tax identifier and email are submitted to create the provider customer and are not stored in checkout recovery storage.
- New quotes carry `PLATFORM_FEE_GUARANTEE_V1`. When the actual receipt is below the promised nominal portion, the platform owes and funds the difference. Owed compensation is separate from funds actually available for withdrawal. See [settlement and operational recovery](giftPricingSettlement.md).
- Issued checkouts recover under their original conditions before new pricing is considered. New attempts revalidate receiving eligibility, gift identity, pricing evidence and current terms under the existing reservation boundaries.
- The guides explain symbolic gifts, included fees, installment totals, monthly release versus available balance, the minimum gift amount and platform coverage of tariff differences.

Migration `0028_gift_payment_settlement.sql` must be applied through the normal verified migration process before running this API version. It adds installment identity and durable compensation tracking; generating or testing it is not a production migration. Existing Asaas webhook subscriptions must include the payment split and deletion events configured by the current registration operation.

### Current validation

The complete unit suite passed 8,819 tests across 342 files. All 141 database integration tests passed against a disposable local PostgreSQL instance after applying the full migration chain. Offline schema generation reported no changes. Workspace checks, lint, typecheck, production builds, public artifact checks and diff whitespace checks passed. Existing lint warnings remain.

The actual panel and guest components were visually checked with synthetic data at desktop and mobile widths. Sandbox evidence confirms exact installment amounts and split allocation, but card capture stopped at the provider's reCAPTCHA. Compensation transfers were tested with deterministic responses and PostgreSQL; no actual compensation was dispatched. The current Sandbox platform key lacks transfer-read permission, which prevents the worker from arming a dispatch. See [provider evidence and limitations](sandboxBuyerGrossUpQa.md).

No shared database migration or production deployment was performed by these checks.

## Historical rollout notes

The sections below record earlier implementations and QA, including the old selectable responsibility and commercial release gates. They are historical evidence, not the current product policy. The original implementation was on `feat/gifts-panel`, based on `37dc6dd`; migrations 0022–0025 were subsequently applied to the verified development configuration after explicit approval.

## Storage and endpoints

Migration `0025_gift_pricing_settings.sql` adds a three-column table keyed to the site. The generated Drizzle snapshot and journal are included. SQL generation was checked offline, followed by a second generation reporting no schema changes. Applying the migration must precede running this application version against a database.

Private endpoints:

- `GET /v1/sites/:siteId/gift-pricing-settings`
- `PATCH /v1/sites/:siteId/gift-pricing-settings` with `{ feeAllocation, revision }`
- `POST /v1/sites/:siteId/gift-pricing-preview` with `{ nominalCents, feeAllocation }`

Settings use an atomic revision comparison and the same site lock used by checkout reservation. Access is checked again after waiting for the lock. An absent preview composition returns unavailable rather than inventing fees.

## Validation and handoff

Logic tests were written and observed failing before the associated changes: stored buyer preference was ignored, settings revision was missing from snapshots, catalog displayed the nominal buyer amount, changed settings/amount/pricing still emitted checkout, revoked access after locking was accepted, and an unavailable settings read guessed recipient allocation. Those tests now pass. Reconciliation tests separately cover exact and divergent explicit buyer settlement, recipient settlement and historical unmarked quotes.

Run the repository checks using the Linux Node/Bun toolchain:

```sh
export PATH=/home/lfrca/.bun/bin:/home/lfrca/.local/bin:$PATH
bun run test
bun run lint
bun run typecheck
bun run build
node node_modules/vitest/vitest.mjs run --config vitest.database.config.ts apps/api/src/giftPricingSettings.db.test.ts
```

The database integration check stops at the existing identity gate: `DATABASE_TEST_BRANCH_ID` is missing. The approved development migration chain was applied separately; no disposable identity was guessed and no production database was used for tests. Sandbox checkout/settlement was not validated for this change. Unit tests and the UI harness do not establish sandbox success.

Normal development uses `bun run dev`, with the admin on port 3000. It requires a verified development database with migration 0025 applied (now verified in development), an authenticated administrative session and the existing receiving readiness configuration.

A local visual harness is running at `http://localhost:4317/`. It imports the real panel components and CSS, uses clearly labeled synthetic data and fictitious test fees, and does not connect to the database or Asaas. Its files are ignored under `apps/admin/work/gift-preview/`. Restart if needed:

```sh
cd apps/admin
node node_modules/vite/bin/vite.js --config work/gift-preview/vite.config.mts
```

Desktop and mobile layouts were inspected in the embedded browser; changing responsibility exposes impact confirmation before saving. This is component evidence, not an end-to-end authenticated application or provider test.

### Operational QA follow-up

The normal admin was stuck before hydration because the local visual harness and the admin shared Vite's dependency cache. The admin requested `@tanstack_react-router_n_@tanstack_react-store.js` from its old optimizer graph, but that request returned `504 Outdated Optimize Dep` after the harness replaced the cache. The ignored harness configuration now sets its own `cacheDir` to `work/gift-preview/.vite`. Reloading the admin Vite configuration regenerated its dependency graph without restarting the API or changing sessions. The embedded browser then followed `/` to `/login`, rendered the login form and enabled its submit button. For QA, wait for the visible login heading **and** the enabled `Entrar` button; an HTTP 200 or server-rendered heading alone does not establish hydration. The authenticated gifts journey still requires QA's product login.

The ignored local helper below uses the installed Linux Bun binary, the canonical environment files and the existing database identity verifier. Its default operation opens a read-only transaction and selects only current sandbox receiving references. It prints presence and comparison flags, never references, credentials, provider payloads or personal fields. It does not require the disposable test identity because it does not run the mutating test harness.

```sh
wsl.exe -d Ubuntu --cd /home/lfrca/projetos/personal-projects/entrelacos/packages/database --exec /home/lfrca/.bun/bin/bun work/inspectSandboxReceiving.ts --self-test
wsl.exe -d Ubuntu --cd /home/lfrca/projetos/personal-projects/entrelacos/packages/database --exec /home/lfrca/.bun/bin/bun work/inspectSandboxReceiving.ts
```

Both commands were executed successfully. Development identity matched the supplied configuration; exactly one current sandbox binding was found, both references were present and its account reference differed from the configured platform account. No provider comparison was performed by the author. If selection becomes ambiguous, QA must set `QA_SITE_ID` locally for the intended site rather than guessing a receiver.

Only independent QA should invoke the explicit provider comparison:

```sh
wsl.exe -d Ubuntu --cd /home/lfrca/projetos/personal-projects/entrelacos/packages/database --exec /home/lfrca/.bun/bin/bun work/inspectSandboxReceiving.ts --compare-sandbox
```

That opt-in permits only GET requests to the fixed `https://api-sandbox.asaas.com` host, refuses redirects and unsafe paths, and compares identifiers in memory. It uses the official [single-subaccount lookup](https://docs.asaas.com/reference/recuperar-uma-unica-subconta), [authenticated wallet lookup](https://docs.asaas.com/reference/recuperar-walletid) and [commercial information lookup](https://docs.asaas.com/reference/recuperar-dados-comerciais), checked 2026-10-29. A missing account identifier in a provider response remains inconclusive; a matching wallet is not substituted for account identity. This is identification only: it does not query fees, create a charge or establish financial release.

## Listening

The review follow-up fixes the pending-allocation preview before saving. The confirmation now estimates the lowest and highest registered gift values for Pix and single-payment card using the selected allocation; the effective setting and editor labels remain unchanged until the PATCH succeeds. Cancelling discards that preview, and late responses from a cancelled selection cannot replace the current simulation.

Pricing evidence validation is shared between purchase quotes and private simulations. Simulations calculate the requested allocation directly, so a small buyer amount remains calculable even when the same amount cannot cover recipient deductions. The synthetic regression case uses nominal 100 cents, commission 2 cents and fixed processing 199 cents: buyer total 301 cents, intended receipt 100 cents. These are test values, not Asaas tariffs. The buyer purchase gate remains unchanged.

Development inspection verified the runtime and direct connection identities against the supplied configuration, including matching endpoint and database. Both paths to the ignored environment file identify the same inode and contents; no credentials were copied or logged. No explicit development branch identifier is configured, so this is endpoint/database verification rather than an independent branch-name assertion. The database journal contains 22 recognized migrations; 0022, 0023, 0024 and 0025 are pending. Applying 0025 alone through the normal migrator would skip the preceding migration timestamps, so it must not be inserted out of order. The preceding migrations alter withdrawal authorization and Pix preparation/consent, beyond the newly added gifts table. The user then explicitly approved applying 0022–0025. The standard Drizzle migrator completed successfully; the subsequent read-only inspection found all 26 known migrations applied, no pending or unknown migration hashes, and the new settings table present. No migration files from 0022–0024 were edited.

A separate, non-destructive development probe exercised the actual PostgreSQL service queries against four verified session-temporary relations inside an outer transaction. It checked default projection, save/read and revision conflict, other-site isolation, assistant denial and authorized admin reads, then rolled back. Shared business rows were not written. This is real PostgreSQL SQL evidence, not an authenticated HTTP flow or cross-connection acceptance. The probe is retained locally under `packages/database/work/validateGiftDevelopment.ts`, and its identity/migration inspection under `packages/database/work/inspectGiftDevelopment.ts`; both are ignored and print sanitized status only. Admin `http://localhost:3000/` and API `http://localhost:8080/v1/health` returned HTTP 200 after the migration; authenticated journeys remain for independent QA.

The integration harness still requires a distinct test endpoint and `DATABASE_TEST_BRANCH_ID`, `DATABASE_DEVELOPMENT_BRANCH_ID`, `DATABASE_PROJECT_ID` and the expected database identity. Development authorization does not satisfy that disposable-test requirement. Two cross-connection tests were added to `giftCheckoutRepository.db.test.ts`: a settings commit first prevents provider dispatch, while a checkout reservation first retains its original recoverable commitment after settings change. They use owned fixtures, explicit transaction barriers and observed PostgreSQL lock waits. Their execution remains blocked by the existing test identity gate; no concurrency success is claimed from mocks or typechecking.

The follow-up review found that the reservation-first barrier also paused the preceding read-only request lookup. The shared test-only barrier now ignores read-only transactions and signals only after a write callback completes, before commit. An offline regression using the actual checkout repository confirms that lookup never signals and reservation has already acquired the site lock and inserted its commitment when it signals. This checks ordering, not actual PostgreSQL contention; the two-connection acceptance still requires the verified disposable target. Runtime repository behavior was not changed for a test hook.

Saving buyer responsibility pauses new purchases instead of presenting an unsupported promise of full receipt. Disabling the choice entirely would hide the requested responsibility model; enabling checkout from observed fee estimates would violate the confirmed gate. The confirmation explains the pause before saving, and switching back restores recipient pricing for new quotes.

The Asaas documentation confirms that percentage splits use `netValue`, after provider fees; fixed splits preserve the specified commission amount: <https://docs.asaas.com/docs/split-de-pagamentos> and <https://docs.asaas.com/docs/checkout-with-payment-split> (checked 2026-10-28). Public pricing pages do not establish the terms applicable to an individual receiving account.

Release of buyer checkout still requires independently verified, account- and method-bound future fee conditions, validity/rounding/complete applicable charges, an approved policy for positive and negative settlement differences, and a real sandbox integration run. No absorption policy was invented. The public contract intentionally admits only unavailable buyer pricing until this gate is resolved; enabling priced buyer cards requires extending that contract with server-priced per-method totals and integration evidence.

Recipient-deducted processing differences continue to credit the actual verified receipt. Both original quotes and actual payment amounts remain stored and visible to the existing historical comparison; they are not rewritten. Explicit buyer processing differences now enter the existing divergent-allocation path. See `giftPricingSettlement.md` for the reconciliation tradeoff and follow-up.

### Catalog mutation readiness revalidation

Authenticated catalog publication exposed an application-side lock cycle. The first readiness check can reuse the receiving refresh throttle, while the second check under the site lock can cross that throttle boundary and start a provider refresh on a separate connection. The refresh then waits for the site lock held by the request that is awaiting the refresh. PostgreSQL sees a waiting transaction and an idle transaction rather than the complete application dependency cycle.

Catalog mutations now pass their existing transaction through the app readiness binding. The receiving repository reads stored context in that transaction without a provider refresh or a nested snapshot. The normal pre-lock read can still refresh evidence. The post-lock capability, freshness, bank verification and receiving eligibility checks remain mandatory; stale stored evidence still rejects the mutation. Removing the final check or trusting the pre-lock projection was rejected because eligibility can change while acquiring the lock. This shared boundary also serves media mutations; no storage behavior or payment gate was relaxed.

Focused regressions cover publication with the locked transaction, actual app binding propagation, and the real Drizzle receiving reader with fresh and stale bank evidence. They establish transaction routing and fail-closed behavior without using the destructive database harness. The local operational investigation also found a stopped API child behind a surviving development watcher; checking its listener and authenticated business routes was necessary before retrying the existing fixture. No new fixture or financial charge is required for this retry.


### Hosted checkout return origins

The independently correlated Sandbox request on 2026-10-29 at 15:23 UTC returned HTTP 400: Asaas rejected `successUrl`, `cancelUrl` and `expiredUrl`. The local composition had sent the root callback built from `GIFT_PUBLIC_ORIGIN=http://localhost:4321`. The provider's generic field errors establish rejection of those exact URLs, not which internal hostname/protocol validator rejected them. The official [creation contract](https://docs.asaas.com/reference/criar-novo-checkout) requires the callback object, and the [callback guidance](https://docs.asaas.com/docs/erros-comuns-e-boas-pr%C3%A1ticas) requires real application routes. HTTPS examples alone do not prove that changing only the scheme would work.

The existing HTTPS callback policy now has no Sandbox loopback exception. The shared `readAsaasCheckoutCallbacks` reader rejects non-HTTPS, loopback/IP or single-label origins, foreign callback origins and credentials/query/fragment data. It preserves the three configured routes. Syntactic acceptance is not proof that the destination exists or that Asaas will accept it; the operator must verify the real registered destination before enabling checkout.

The actual composition supplies a pure configuration preflight. New checkout requests run it after existing-request recovery and before reading/reserving a new quote. Invalid configuration returns `503 / CHECKOUT_CONFIGURATION_INVALID` without provider dispatch or an UNKNOWN reservation. Existing issued checkout recovery and genuine uncertain-delivery outcomes remain unchanged. A historical HTTP 400 does not authorize a blanket safe retry or a database reclassification.

Local browser origins remain valid for the panel, public catalog and signed handoff; they are separate from PSP return URLs. Checkout recovery uses origin-scoped browser session storage, so sending a checkout started on localhost to a different public origin would lose its recovery context. Begin the complete QA journey on the approved callback origin. Do not replace callbacks with a fictitious host, change HTTP to HTTPS without a real service, or pass recovery tokens in return URLs.

The already registered development origin `https://demo-dev.entrelacos.workers.dev` returned HTTP 403 during this investigation. No usable public destination was established, and the two former quick-tunnel origins are not a fallback. Keep the local configuration blocked until an approved current demo frontend is actually served and verified at a registered HTTPS origin. Restoring/publishing that frontend is an external action requiring separate approval; no tunnel, deployment, DNS or origin record was changed here. Webhook reachability remains a separate integration prerequisite.
