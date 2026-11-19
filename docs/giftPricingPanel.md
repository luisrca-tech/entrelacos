# Gift pricing

## Current policy (Pagar.me, 2026-11)

The guest pays every cost; the couple receives 100% of the gift value they registered. The panel explains this fixed policy instead of asking who pays. `PATCH /v1/sites/:siteId/gift-pricing-settings` only accepts `BUYER_GROSS_UP` and never rewrites old quotes or purchase snapshots.

All numbers come from one table, `GIFT_PLATFORM_TARIFFS` in `packages/contracts/src/giftTariffs.ts`. The API quote, the couple's preview in the panel and the public landing example all call `quoteGiftV2` / `listGiftV2Options` in `packages/contracts/src/giftPricingV2.ts`, so they cannot drift apart. New quotes carry `settlementVersion = "PLATFORM_ACCOUNT_SPLIT_V2"`.

### Formula

The quote is frozen when the guest opens the payment. With `V` = gift value in cents:

- `comm = round(V × 2%)` (`GIFT_COMMISSION_BASIS_POINTS = 200`).
- Fixed fees per transaction: card `99` (gateway 55 + antifraud 44), Pix `PIX_FIXED_CENTS = 55` (still to confirm with Pagar.me whether the gateway fee applies to Pix).
- Card in `n` installments: `G = ceil((V + comm + 99) / (1 − CET[n]))`, where `CET[n]` is the D+2 effective cost for `n` (MDR, automatic anticipation and chargeback guarantee).
- Pix: `G = ceil((V + comm + PIX_FIXED_CENTS) / (1 − Pix MDR))`.
- Couple split amount: card `C = ceil(V / (1 − ANT[n]))` with `ANT[n] = monthly anticipation rate × mean((30·i − 2) / 30)` for `i = 1..n`; Pix `C = V` (Pix is never anticipated).

`G` is what the guest pays, split into equal installments with the remainder on the last one. After Pagar.me anticipates the couple's receivables, the couple nets `V`. The platform keeps `G − costs − C`, which the tests keep at or above `comm` for every installment count.

### Installments and limits

- Card: 1x to 6x (`maxInstallments: 6`). There is no 7–12x tier. Each installment must be at least R$5.00 (`minimumInstallmentCents: 500`); options below that are not offered.
- Pix: a single payment, available immediately after confirmation.
- Card: the whole value is available to the couple in about 2 days, for any installment count, because the couple recipient has automatic anticipation on.
- New and updated gift values must be at least R$5.00. Smaller historical gifts stay readable but cannot be published or quoted until corrected.

### Split

Each order carries the split decided in D2:

- Platform recipient (`PAGARME_PLATFORM_RECIPIENT_ID`): `G − couple amount`, with `liable`, `charge_processing_fee` and `charge_remainder_fee` on. It absorbs MDR, fixed fees, chargebacks and rounding.
- Couple recipient: flat amount `C` with every option off. Whether `C` is sent once (`charge_total`, default) or per installment (`per_installment`) is set by `GIFT_PLATFORM_TARIFFS.couplesSplitMode`, pending the sandbox payables test in [Pagar.me operation](pagarmeOperation.md).

### Couple receiving and withdrawal

- Identity verification: the owner opens **Verificar identidade** in the panel; the API returns a Pagar.me KYC link and QR code valid for about 20 minutes and never stores them. Receiving starts only after the recipient is approved.
- Withdrawal: R$3.67 per withdrawal (`withdrawalFeeCents: 367`), with no exemption claimed for any bank. The fee is shown before confirming and deducted from the couple's balance; it is not part of the gift price.

### Panel and guest surfaces

- **Simular taxas e parcelamento** (gift editor and pricing screen) calls `POST /v1/sites/:siteId/gift-pricing-preview` and shows the guest total for Pix and each card option. Picking an installment count there is a simulation only; the guest chooses at checkout.
- The couple sees one `Taxas` amount: commission plus processing plus anticipation, all paid by the guest.
- Guests see the server-calculated price with fees included. A missing price never falls back to the nominal amount. Changing method or installments produces a fresh quote before confirmation.
- The public FAQ (`apps/landing/src/faqContent.ts`) and its pricing table (`apps/landing/src/components/PricingExample.astro`) read the installment limit, the withdrawal fee and every amount from the same contracts.

## Settings storage and endpoints

Migration `0025_gift_pricing_settings.sql` adds a three-column table keyed to the site. Private endpoints:

- `GET /v1/sites/:siteId/gift-pricing-settings`
- `PATCH /v1/sites/:siteId/gift-pricing-settings` with `{ feeAllocation, revision }`
- `POST /v1/sites/:siteId/gift-pricing-preview` with `{ nominalCents, feeAllocation }`

Settings use an atomic revision comparison and the same site lock as checkout reservation. Access is checked again after waiting for the lock.

Catalog mutations pass their transaction through the readiness binding, so the post-lock eligibility check reads stored receiving context in that transaction without starting a provider refresh on a second connection (which used to deadlock against the site lock). Stale stored evidence still rejects the mutation.

## Environment

API: `PAGARME_MODE`, `PAGARME_SECRET_KEY`, `PAGARME_PLATFORM_RECIPIENT_ID`, `PAGARME_WEBHOOK_BASIC_USER`, `PAGARME_WEBHOOK_BASIC_PASSWORD`, `PAGARME_BACKGROUND_PROCESSING`, `PAGARME_LIVE_DEMO_SITE_ID`. Couple sites: `PUBLIC_PAGARME_PUBLIC_KEY` (tokenizes cards in the browser) and the existing `PUBLIC_GIFT_PAYMENTS_ENABLED`. Values per environment are in [Pagar.me operation](pagarmeOperation.md) and [showcase operations](showcaseOperations.md).

## Listening

- The CET for each installment count was chosen over summing MDR and anticipation separately: it keeps the price conservative and auditable against a single published number per count.
- 7–12x was dropped by product decision; the card tariff table only defines CET values for 1–6x.
- The couple gets a fixed split amount instead of a percentage so that their receipt never depends on processing fees; the platform recipient absorbs the variance as `liable`.
- Earlier provider-specific rollouts (selectable fee responsibility, platform compensation transfers, hosted checkout) are recorded in Git history and in the [decision register](decisionRegister.md); they no longer describe current behavior.
