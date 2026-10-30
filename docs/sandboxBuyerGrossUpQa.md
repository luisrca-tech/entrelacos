# Sandbox buyer gross-up homologation

This local change prepares financial QA. It has not deployed, changed remote configuration,
changed stored preferences, or issued a quote, checkout or payment.

## Explicit scope

After independent review, configure the API with
`ASAAS_SANDBOX_BUYER_GROSS_UP_SITE_ID=<authorized-site-slug>`. This is a documented
single-site opt-in, not a browser parameter. Configuration rejects it unless the application
targets development and `ASAAS_MODE=sandbox`. The persisted site must be a demo and the
current receiving account must match the Sandbox binding. No private identifiers are
embedded in source. With the variable absent, existing behavior is unchanged.

Quote creation, fresh/locked reservation eligibility, provider composition and payload
construction enforce the scope. Provider-origin, verified, fresh native fee observations
are still required. The snapshot records `SANDBOX_BUYER_ESTIMATE`, allocation, settings
revision, method, coefficients, version and expiry. Production/live cannot use this marker
to create a new commitment. Removing the opt-in prevents new commitments while preserving
recovery and financial processing of already issued operations.

The public catalog permits method selection only for this scope. It does not advertise the
intended recipient net as a purchase price: the selected-method quote supplies the final
guest total before confirmation. The administrative and quote surfaces disclose Sandbox
homologation and no guaranteed net. Commercial `buyerGrossUpAvailable` remains false;
the separate optional `sandboxBuyerGrossUpAvailable: true` describes only this capability.
Administrative previews keep `guaranteed: false`.

## Fee evidence and arithmetic

A scoped official GET of the receiving account fees completed at 2026-10-30 00:40:04 UTC:

- Pix FIXED: base BRL 1.99, promoted BRL 0.99, expiry 2027-01-16 00:00:00.
  The response still reports 100 monthly free credits and zero consumed, despite the
  earlier own Sandbox receipt charging BRL 0.99. The cause is unverified.
- Single-installment card: fixed BRL 0.49, base 2.99%, active discounted 1.99%,
  expiry 2027-01-16 00:00:00.

The existing date interpretation is Sao Paulo wall-clock time, validated through Intl.
Missing/ambiguous tariff or quota fields fail closed. Quotes expire within five minutes
and before applicable promotion expiry; a pre-issuance fee refresh changes the policy hash
when the returned payment schedule changes, requiring a refreshed quote/confirmation.

Buyer homologation deliberately uses the paid Pix tariff returned by the account rather
than promising an unreserved free credit. This does not prove the prior recipient estimate
was a calculation bug or that quota exhaustion occurred. Recipient estimates retain their
existing semantics. No fixed fee is hardcoded from a receipt.

Commission remains rounded 2% of nominal, passed as a fixed split, independent of the
grossed-up total. The existing integer-cent solver estimates processing on the full charge:

`total = ceil((nominal + commission + fixed) * 10000 / (10000 - rate))`

Under the observed schedule and the existing CEILING estimate, nominal 1000 cents gives
Pix total 1119 (processing 99, split 20) and card total 1091 (processing 71, split 20).
These are illustrative calculations from the current observation, not approved future
checkout totals or proof of net receipt. New QA must use fresh quotes.

The prior BRL 10 card receipt charged 68 cents while the existing estimate would be 69.
The account-fees response does not establish the exact provider rounding algorithm for all
amounts. This change does not infer truncation from one receipt or replace arithmetic with
fixture-specific constants.

Sources: [account fee endpoint](https://docs.asaas.com/reference/recuperar-taxas-da-conta),
[fee simulator announcement](https://docs.asaas.com/changelog/endpoint-para-simular-taxas-de-cobran%C3%A7as).
The announcement's linked simulator reference currently returns 404; no simulator request
was sent and no undocumented endpoint was guessed.

## Settlement acceptance and next execution

1. Review the local diff independently, then publish the reviewed API/admin/site changes
   and set only the development Sandbox opt-in. No migration is required.
2. Use the existing authorized fixture and normal settings UI to select buyer allocation.
   Confirm fresh quote method, nominal, processing estimate, fixed split and guest total.
3. Obtain explicit item/total confirmation before each simulated payment. Use new quotes
   and normal checkout flow; never reuse an old quote, repeat a prior payment or repair SQL.
4. Read the same payment and checkout, authenticated webhook processing, settled split,
   observed processing, net and ledger count. Compare observed net with intended nominal.
5. A processing difference in either direction remains `DIVERGENT / ALLOCATION_MISMATCH`,
   with the observed amounts preserved and no local receipt credit. Exact matching receipt
   retains the existing idempotent credit path. Never force a 1000-cent credit or invent a
   party responsible for a difference. Restore the prior allocation through the UI.

No product decision is needed to observe a fictitious Sandbox difference under this
existing fail-closed rule. Commercial release still needs applicable tariff/rounding
evidence and an explicit policy assigning any shortfall or surplus. This opt-in does not
decide that policy. Runtime financial and visual acceptance remain independent QA work.

## Listening

An explicit, single-site Sandbox capability was selected instead of removing the buyer
gate globally or fabricating contractual fee authority. The native schedule remains an
estimate, paid Pix pricing avoids promising the contradicted free quota, and strict
settlement divergence exposes discrepancies for homologation. A generic feature-flag
framework, a new database setting, changed historical snapshots, automatic absorption,
and guessed provider rounding were rejected as unnecessary or unsupported.
