# Gift pricing settlement

New quotes freeze the guest's final BRL total, the couple's nominal gift amount and a commission of 2% of nominal, rounded to the nearest cent. The `PLATFORM_FEE_GUARANTEE_V1` marker applies the funding guarantee. Existing snapshots without the marker continue under their original settlement rules.

For example, a guest pays R$102.39 for a R$100.00 gift with a R$2.00 commission and a R$0.39 estimated Asaas fee. If Asaas takes R$0.40, the verified payment contributes R$99.99 to the couple's wallet and Entrelacos owes R$0.01. The guest's total and the couple's promised nominal amount remain fixed. A lower actual fee increases the verified credit and requires no adjustment.

## Historical snapshots

An explicit historical `BUYER_GROSS_UP` quote still requires the actual processing fee to match the frozen estimate. A difference follows the existing allocation-mismatch retry path. Historical `RECIPIENT_DEDUCTED` quotes and snapshots without a fee allocation continue to settle the observed provider net less the verified commission. A quoted zero processing fee on those snapshots can be a pricing placeholder.

## Installment receipt

The couple's history includes only orders with a verified confirmed or received payment, or retained evidence of a prior payment. Opening checkout, pending charges, expiration and unpaid cancellation remain internal. The same visibility rule applies before list pagination and to direct detail access. A previously credited or confirmed gift remains traceable after a refund; opening a payment page is never presented as a receipt.

Symbolic gifts have no inventory or purchase limit. Each independent guest intent creates its own quote and order. Posting a payment never unpublishes the gift. Quote creation and checkout reservation acquire the site lock before receiving-account locks so simultaneous purchases of the same gift cannot invert that lock order.

Asaas identifies each charge with its own payment ID and groups installments under the plan ID. The plan ID and attempt reference must match the stored checkout operation. The installment number selects the gross and the nominal and fixed commission portions. Rounding remainders are applied to the last installment, so the parts sum to the original amounts. The same installment position may only be bound to one payment for the order. The canonical receipt effect remains unique per provider payment.

A verified `CONFIRMED` payment can appear as awaiting release. A receipt requires Asaas `RECEIVED` and the exact settled fixed split. The worker refreshes provider evidence on either `PAYMENT_RECEIVED` or `PAYMENT_SPLIT_DONE`. Existing webhook registrations can be updated through the existing registration operation to subscribe to split settlement and payment deletion events.

A direct installment invoice has a 60-minute payment window starting when the application records the hosted invoice. At the cutoff, recovery hides the payment link. A background worker checks the complete native plan and asks Asaas to permanently remove it only when each charge is pending or overdue and no local payment evidence conflicts. The operation records a durable dispatch marker before the request. Asaas permits removal only while the plan meets its unpaid-state and other removal conditions. A scoped authenticated provider read then confirms that the exact plan is gone. A lost removal response uses the same read and local payment checks to resolve the outcome. Provider outages can delay cancellation; an uncertain result never unlocks another attempt.

A deleted individual charge can be restored. The closure records the provider confirmation under the order lock after checking for payments and authenticated receipt events. A correlated deletion webhook uses the same provider confirmation for manually removed plans.

Migration `0029_gift_installment_expiry.sql` must precede this API version. It adds nullable native payment references to each checkout attempt. These references are committed with the dispatch marker, so a payment-ID-only confirmation or dispute still prevents closure after a crash or lost response. Existing orders and payment records are retained.

## Platform compensation

The receipt transaction posts the actual provider credit and records any positive shortfall as an obligation. A worker verifies the platform wallet, its available funds, transfer-read permission and the original payment’s current status before attempting an internal transfer to the frozen, linked Asaas wallet. It consumes a durable dispatch fence before the POST, and stores the transfer ID only when the response proves correlation, destination and amount. A later authenticated read can complete a known transfer. An adjustment counts as funded only after Asaas reports `DONE` with the expected net amount.

The financial overview separates amounts still owed from funded adjustments. A funded adjustment increases cumulative net received once and has no second gift receipt. The original provider net and actual Asaas fee remain visible in history. Withdrawals continue to use the actual Asaas account balance and its existing authorization and consistency checks.

An insufficient platform balance leaves the obligation queued until funding is available. After an ambiguous POST, the worker searches for the stable external reference and requires destination evidence before binding the transfer. The destination statement can confirm a credit by the same transfer ID and exact amount when the outgoing transfer record omits the wallet identifier. If provider reads cannot prove the destination, the obligation remains open for operations. A definitive failure or cancellation keeps the amount owed and parks the payment record with a transfer reference and an infinite next-attempt timestamp. Operations must resolve the failed or unverified dispatch before any subsequent attempt.

## Listening

The durable obligation lives with the receipt because the provider fee difference can be known before funding. A second gift receipt would count the original gift twice. Keeping the original receipt and recording the funded adjustment separately preserves the original gross, commission and fee conservation while allowing an operator to track what the platform still owes.

## Provider references

- [Asaas installments](https://docs.asaas.com/docs/installments)
- [Split into installments](https://docs.asaas.com/docs/split-em-parcelamentos)
- [Payment events](https://docs.asaas.com/docs/payment-events)
- [Transfer to an Asaas account](https://docs.asaas.com/reference/transfer-to-asaas-account-1)
- [Retrieve a single transfer](https://docs.asaas.com/reference/retrieve-a-single-transfer)
- [List transfers](https://docs.asaas.com/reference/list-transfers)
- [Account statement](https://docs.asaas.com/reference/retrieve-extract)
- [Remove installment](https://docs.asaas.com/reference/remove-installment)
- [Retries and idempotency](https://docs.asaas.com/docs/retries-and-idempotency)
