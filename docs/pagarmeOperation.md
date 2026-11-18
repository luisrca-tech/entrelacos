# Pagar.me operation

How the API takes guest payments through Pagar.me v5, what the operator configures in the dashboard, and what to do when money moves backwards. Pricing rules live in `packages/contracts/src/giftTariffs.ts` and `giftPricingV2.ts`.

## Settings (API)

| Variable | Notes |
|---|---|
| `PAGARME_MODE` | `disabled`, `test` (stored as the `sandbox` financial environment) or `live` (production only). |
| `PAGARME_SECRET_KEY` | `sk_test_…` in test, live key in live. Used as the Basic auth username (empty password). Never logged. |
| `PAGARME_PLATFORM_RECIPIENT_ID` | `rp_…` of the Entrelaços default recipient. It is the `liable` recipient on every split. |
| `PAGARME_WEBHOOK_BASIC_USER` / `PAGARME_WEBHOOK_BASIC_PASSWORD` | Credentials Pagar.me sends on each webhook. Password: 32+ random printable characters, different per environment (`openssl rand -base64 36`). Only a sha256 of `user:password` stays in memory. |
| `PAGARME_BACKGROUND_PROCESSING` | `true` runs the payment worker outside production too. |

## Webhook setup

1. Dashboard → Configurações → Webhooks → new webhook, one per environment:
   - local: `https://<cloudflared tunnel>/v1/webhooks/pagarme`
   - dev / prod: `https://<api host>/v1/webhooks/pagarme`
2. Enable HTTP Basic authentication with the user and password from the table above.
3. Subscribe to: `order.paid`, `order.payment_failed`, `order.canceled`, `charge.paid`, `charge.refunded`, `charge.chargedback` (the API also accepts `charge.chargeback`; confirm which spelling the dashboard lists) and `recipient.updated`.

What the endpoint does:

- Missing or wrong credentials → `401` (constant-time comparison of digests). Nothing is stored.
- Events of other types → `200`, ignored.
- Each event is stored once in `financial_event_inbox`, keyed by the Pagar.me event id. A redelivery returns `200` and posts nothing new.
- An event that matches no checkout or recipient → `200` plus an open `UNROUTABLE_PLATFORM_EVENT` operator alert.
- Storage failure → `503`, so Pagar.me retries.
- The webhook body is never trusted for money or status. The worker re-reads `GET /orders/{id}` (or the recipient) and only then writes the ledger.

## Guest checkout

`POST /v1/public/sites/:siteId/gift-checkouts` takes `{ quoteId, requestId, recoveryToken, method, installments, cardToken?, buyer }` and returns `{ checkoutId, status, pix? }`. The card is tokenized in the browser with the public key. Any raw card field (`number`, `cvv`, …) is rejected with `400`. `requestId` + `recoveryToken` make retries return the same checkout and authorize `POST …/gift-checkouts/status`.

The API sends `POST /orders` with `code = checkoutId` and `Idempotency-Key = checkoutId`:

- One item of `G` (the frozen quote total), customer `individual` with CPF and mobile phone, `closed: true`.
- Pix: `pix.expires_in` = seconds left on the quote. Card: `card_token`, `installments` (1–6), `statement_descriptor: "ENTRELACOS"`, `operation_type: "auth_and_capture"`.
- Split: the platform recipient gets `G − couple` (`liable`, `charge_processing_fee`, `charge_remainder_fee` on), and the couple recipient gets the flat couple amount with every option off. The two always add up to `G`. The couple amount is `C` (`charge_total`) or `ceil(C / n)` (`per_installment`), switched by `GIFT_PLATFORM_TARIFFS.couplesSplitMode`.

Refused before dispatch: expired quote (`409 QUOTE_EXPIRED`), quote from another provider (`409 PROVIDER_UNAVAILABLE`), more than 6 installments (`422 INSTALLMENTS_UNAVAILABLE`), method or installments differing from the quote (`422 QUOTE_MISMATCH`), and a couple recipient that is missing, not active or equal to the platform recipient (`409 RECEIVING_NOT_READY`). A Pagar.me `4xx` closes the attempt (`422`). A `5xx` or timeout leaves it `OUTCOME_UNKNOWN` for reconciliation.

### Ledger effects

| Re-read order/charge | Effect |
|---|---|
| `paid` with the expected amount and couple split | One `gift_payment_record` per charge (gross `G`, commission, couple net `V`, couple rule amount, platform share `G − C`) and one `GIFT_RECEIVED` credit of `V`. |
| `failed` / `canceled` | Checkout closes unpaid (`FAILED`, `CANCELED`, or `EXPIRED` for a Pix past its expiry). No ledger entry. |
| `refunded` / `chargedback` | Payment marked `REFUNDED` / `CHARGEBACK`, one `GIFT_REFUNDED` / `GIFT_CHARGEBACK` debit compensating the credit, and an operator alert (refund: warning; chargeback: critical). |
| Different code, amount, installments or split | No credit. Opens an `ORDER_MISMATCH` critical alert. |

### Reconciliation

Every checkout still unresolved 10 minutes after creation (pending order, unknown creation outcome or lost dispatch lease) gets an `ORDER_RECONCILE` inbox event, at most once every 10 minutes for 7 days. The worker re-reads `GET /orders/{id}`, or `GET /orders?code=<checkoutId>` when the order id is unknown, and applies the table above. An attempt with no order 10 minutes after its quote expired is closed as `FAILED` (`ORDER_NOT_FOUND`).

## KYC

The owner, or the recipient operator, calls `POST /v1/owner/sites/:siteId/receiving/kyc-link`. The API calls `POST /recipients/{id}/kyc_link` and returns the URL and QR code once. They are valid for about 20 minutes and never stored. Status changes arrive through `recipient.updated`, and the worker re-reads `GET /recipients/{id}`.

## Withdrawals

- Fee: R$ 3,67 per withdrawal, shown before confirming and recorded with the withdrawal.
- `POST /recipients/{id}/withdrawals` is sent with `Idempotency-Key = withdrawal:<operationId>`. A retry of an unknown outcome reuses the same key for up to 1 hour after the withdrawal was requested. **To confirm in the sandbox:** the Pagar.me v5 reference does not state how long it keeps an idempotency key. If it turns out to be shorter than 1 hour, lower the replay window in `pagarmeWithdrawalClient.ts`.
- A definitive refusal (`400`, `404`, `412`, `422`) fails the withdrawal and releases the reserved balance. Pagar.me created nothing in that case, so the failure proof carries a local `rejected_<hash>` reference. `401`, `403`, `409`, `429`, `5xx` and timeouts keep the hold until a lookup resolves it.

## Refunds and chargebacks

- Refunds are operator-only and refund the whole charge: `DELETE /charges/{chargeId}` (`createPagarmeOrderClient(...).cancelCharge(chargeId, "refund:<chargeId>")`). Do not refund from the dashboard without opening the matching alert.
- Chargebacks are absorbed by the platform recipient (`liable`). The debit and the alert appear automatically. If the couple already withdrew, settle the difference manually and resolve the alert with a note.
- Open alerts: `SELECT * FROM financial_operator_alert WHERE resolved_at IS NULL ORDER BY created_at;`

## Sandbox

`tsx apps/api/scripts/pagarmeSandboxProbe.ts [recipient|order|all] [--recipient rp_…]`, run with `PAGARME_MODE=test`, `sk_test_` and the platform `rp_`, plus either `PAGARME_PUBLIC_KEY` (`pk_test_`) or `PAGARME_TEST_CARD_TOKEN`:

- `recipient` creates an individual recipient (automatic anticipation on, transfers off) and checks that the KYC link expires in about 20 minutes.
- `order` places a R$ 100,00 gift in 6x with the split and prints each recipient's payables for the charge. If the couple's total equals `C`, keep `charge_total`; if each installment equals `C`, switch to `per_installment`. Record the result here.

The script never prints keys, tokens or card data.

Test cards (Pagar.me v5 simulator):

| Card | Result |
|---|---|
| `4000000000000010` | approved |
| `4000000000000028` | declined (`order.payment_failed`) |
| `4000000000000069` | approved, then chargeback |

The simulator does not accept Pix with a split. Test Pix end to end without a split; Pix with a split is covered by the payload tests.
