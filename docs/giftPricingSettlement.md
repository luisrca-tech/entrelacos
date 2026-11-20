# Gift pricing settlement

New quotes (`settlementVersion = "PLATFORM_ACCOUNT_SPLIT_V2"`) freeze the guest total `G`, the gift value `V`, the 2% commission, the couple split amount `C` and the installment count. The formula is in [gift pricing](giftPricingPanel.md); the order, webhook and ledger flow is in [Pagar.me operation](pagarmeOperation.md).

## How money is split

Settlement happens inside each Pagar.me order, not afterwards:

- The order is sent with `amount = G` and a two-rule split. The couple recipient gets the flat amount `C` with `liable`, `charge_processing_fee` and `charge_remainder_fee` off. The platform recipient (`PAGARME_PLATFORM_RECIPIENT_ID`) gets `G − C` with all three on.
- Because the platform is `liable` and pays the processing fee and remainder, the couple's share never changes with MDR, fixed fees, rounding or chargebacks.
- The couple recipient has automatic anticipation on and automatic transfer off. Card receivables are anticipated to about D+2 for any installment count; the anticipation discount takes `C` down to `V`. Pix is not anticipated and `C = V`.

There is no platform compensation transfer: with a fixed couple split there is no fee difference to fund after the fact.

## Ledger

A paid order is re-read with `GET /orders/{id}` before anything is posted. When the code, amount, installments and split match the stored checkout, the worker writes one `gift_payment_record` per charge and one `GIFT_RECEIVED` credit of `V`. Any difference opens an `ORDER_MISMATCH` operator alert and posts no credit. Refunds and chargebacks post a compensating debit and an alert. See the ledger table in [Pagar.me operation](pagarmeOperation.md).

The couple's history only lists orders with a verified paid charge, or retained evidence of a prior payment. Opening checkout, pending orders, expiration and unpaid cancellation stay internal. A credited gift remains traceable after a refund.

Symbolic gifts have no inventory or purchase limit. Each guest intent creates its own quote and order, and posting a payment never unpublishes the gift. Quote creation and checkout reservation take the site lock before receiving-account locks so simultaneous purchases of the same gift cannot invert lock order.

## Balance and withdrawal

The couple's balance is read from `GET /recipients/{id}/balance` (`available_amount`, `waiting_funds_amount`). A withdrawal (`POST /recipients/{id}/withdrawals`) costs R$3.67 (no exemption is promised for any bank), is shown before confirming and must be larger than the fee. The money goes to the recipient's `default_bank_account`, registered under the same CPF as the couple's account holder.

## Historical snapshots

Quotes stored before the switch keep their original `settlementVersion` (`PLATFORM_FEE_GUARANTEE_V1` or none) and remain readable in history and in the financial overview. They are not repriced, rewritten or settled again. The only such record is a test charge handled manually.

## Listening

Splitting at authorization was chosen over settling after the payment because it is the only point where Pagar.me documents split rules, and it removes the need for compensation transfers and their failure handling. Whether a flat card split applies to the whole charge or to each installment is still open; `couplesSplitAmountCents` isolates that choice and the sandbox probe in [Pagar.me operation](pagarmeOperation.md) decides it.
