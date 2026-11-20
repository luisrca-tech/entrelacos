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
3. Subscribe to: `order.paid`, `order.payment_failed`, `order.canceled`, `charge.paid`, `charge.refunded`, `charge.partial_canceled`, `chargeback.received` and `recipient.updated`. `chargeback.received` replaces `charge.chargedback`, which the Pagar.me event reference marks as discontinued (migration by 2026-09-30); the API still accepts `charge.chargedback` and `charge.chargeback`. A `chargeback.received` body carries a dispute that names the charge (`chargeId`); the API routes it through the stored payment of that charge. Confirm the body shape once in the sandbox.

What the endpoint does:

- Missing or wrong credentials → `401` (constant-time comparison of digests). Nothing is stored.
- Events of other types → `200`, ignored.
- Each event is stored once in `financial_event_inbox`, keyed by the Pagar.me event id. A redelivery returns `200` and posts nothing new.
- An event that matches no checkout or recipient → `200` plus one open `UNROUTABLE_PLATFORM_EVENT` operator alert per foreign order, charge or recipient (not per event). `recipient.updated` for the platform recipient is ignored.
- Storage failure → `503`, so Pagar.me retries.
- The webhook body is never trusted for money or status. The worker re-reads `GET /orders/{id}` (or the recipient) and only then writes the ledger.

## Guest checkout

`POST /v1/public/sites/:siteId/gift-checkouts` takes `{ quoteId, requestId, recoveryToken, method, installments, cardToken?, buyer }` and returns `{ checkoutId, status, pix? }`. The card is tokenized in the browser with the public key. Any raw card field (`number`, `cvv`, …) is rejected with `400`. `requestId` + `recoveryToken` make retries return the same checkout and authorize `POST …/gift-checkouts/status`.

The API sends `POST /orders` with `code = checkoutId` and `Idempotency-Key = checkoutId`:

- One item of `G` (the frozen quote total), customer `individual` with CPF and mobile phone, `closed: true`.
- Pix: `pix.expires_in` = seconds left on the quote. Card: `card_token`, `installments` (1–6), `statement_descriptor: "ENTRELACOS"`, `operation_type: "auth_and_capture"`.
- Split: the platform recipient gets the rest of the charge (`liable`, `charge_processing_fee`, `charge_remainder_fee` on), and the couple recipient gets the flat couple amount with every option off. In `charge_total` mode the rules are `G − C` and `C`. In `per_installment` mode both rules are stated per installment: the installment is `ceil(G / n)`, the couple gets `ceil(C / n)` of it and the platform the rest. `GIFT_PLATFORM_TARIFFS.couplesSplitMode` switches the mode; reconciliation expects the same amounts.

Refused before dispatch: expired quote (`409 QUOTE_EXPIRED`), quote from another provider (`409 PROVIDER_UNAVAILABLE`), more than 6 installments (`422 INSTALLMENTS_UNAVAILABLE`), method or installments differing from the quote (`422 QUOTE_MISMATCH`), and a couple recipient that is missing, not active or equal to the platform recipient (`409 RECEIVING_NOT_READY`). A Pagar.me `4xx` closes the attempt (`422`). A `5xx` or timeout leaves it `OUTCOME_UNKNOWN` for reconciliation.

### Ledger effects

| Re-read order/charge | Effect |
|---|---|
| `paid` with the expected amount and couple split | One `gift_payment_record` per charge (gross `G`, commission, couple net `V`, couple rule amount, platform share `G − C`) and one `GIFT_RECEIVED` credit of `V`. |
| `failed` / `canceled`, never paid | Checkout closes unpaid (`FAILED`, `CANCELED`, or `EXPIRED` for a Pix past its expiry). No ledger entry. |
| `canceled` after payment (v5 has no `refunded` charge status: the last transaction reads `refunded`), `refunded`, `chargedback` | Payment marked `REFUNDED` / `CHARGEBACK`, one `GIFT_REFUNDED` / `GIFT_CHARGEBACK` debit compensating the credit, and an operator alert (refund: warning; chargeback: critical). |
| Partial refund or cancel (`partial_refunded`, `partial_canceled`, `canceled_amount` below the total) | No automatic debit. `ORDER_MISMATCH` critical alert (`PARTIAL_REVERSAL`); the operator decides the couple debit. |
| A paid order later read as closed | No change. `ORDER_MISMATCH` critical alert (`CLOSED_AFTER_PAYMENT_*`). |
| Different code, amount, installments or split | No credit. Opens an `ORDER_MISMATCH` critical alert. |

### Reconciliation

Every checkout still unresolved 10 minutes after creation (pending order, unknown creation outcome or lost dispatch lease) gets an `ORDER_RECONCILE` inbox event, at most once every 10 minutes for 7 days. Every paid order not yet reversed is re-read once a day for 120 days, so a refund or chargeback whose webhook was lost still posts its debit and alert. The worker re-reads `GET /orders/{id}`, or `GET /orders?code=<checkoutId>` when the order id is unknown, and applies the table above. An attempt with no order 10 minutes after its quote expired is closed as `FAILED` (`ORDER_NOT_FOUND`).

A card decided in the creating call (paid or declined) is applied before the create response, so the guest sees the decision right away.

## KYC

The owner, or the recipient operator, calls `POST /v1/owner/sites/:siteId/receiving/kyc-link` (at most 3 links per site per minute; more answer `429`). The API calls `POST /recipients/{id}/kyc_link` and returns the URL and QR code once. They are valid for about 20 minutes and never stored. The panel opens the tab inside the click and fills in the URL when the API answers, so pop-up blockers allow it; the QR image type (PNG or SVG) is read from its bytes. Status changes arrive through `recipient.updated`, and the worker re-reads `GET /recipients/{id}`. Recipient ids may be `rp_`, `re_` or, for recipients created after the 2026-07-14 API change, a `pp_` `payment_profile_id`; all three are accepted.

Recipient data is checked before Pagar.me is called: valid CPF check digits and an adult holder (18+).

## Withdrawals

- Fee: R$ 3,67 per withdrawal, shown before confirming and recorded with the withdrawal.
- Withdrawals use [Transfers](https://docs.pagar.me/reference/criando-uma-transfer%C3%AAncia.md): Pagar.me deprecated `POST /recipients/{id}/withdrawals` in favour of `POST /transfers` with `{ amount, recipient_id }`. It is sent with `Idempotency-Key = withdrawal:<operationId>` (documented on this route), only from inside the dispatch guard (locks, budget, destination, consent, quote and lease). If the guard refuses before the POST leaves, the withdrawal fails with a local `rejected_<hash>` proof and the hold is released.
- A transfer is read with `GET /transfers/{id}`; its integer id is stored as a decimal string. Statuses: `pending_transfer`, `processing`, `transferred` (completed), `failed` and `canceled` (released). A transfer whose `source_id` or `recipient_id` is another recipient is refused. When Pagar.me names the recipient in a format other than the stored one, the recipient is read and the transfer is accepted only if the named id is one of its own ids (`id`, `payment_profile_id` or `gateway_recipients[].pgid`, covering `rp_`, `pp_` and `re_`). Withdrawals recorded before the move (`with_` ids) are still read through the old route; `tran_` ids are charge transactions and are refused as transfer ids.
- Recovery never replays the POST. A transfer whose response was lost is looked up in `GET /transfers?recipient_id=&count=1000`, keeping those created since the request (one match by net amount). An unreadable item (bad shape or no creation date) is skipped and logged as `pagarme_transfer_list_item_skipped` with a count only, so the others still reconcile. Only the first page is read: a full page (1000 items) cannot prove the window is complete, so the lookup stays unresolved and the hold is kept. With no single match after 1 hour, the hold stays and a `WITHDRAWAL_UNRESOLVED` critical alert opens for an operator. Pagar.me sends no transfer webhooks, so the status is polled.
- A definitive refusal (`400`, `404`, `412`, `422`) fails the withdrawal and releases the reserved balance. Pagar.me created nothing in that case, so the failure proof carries a local `rejected_<hash>` reference. `401`, `403`, `409`, `429`, `5xx` and timeouts keep the hold until a lookup resolves it.

## Refunds and chargebacks

- Refunds are operator-only and refund the whole charge: `DELETE /charges/{chargeId}` (`createPagarmeOrderClient(...).cancelCharge(chargeId, "refund:<chargeId>")`). Do not refund from the dashboard without opening the matching alert.
- Chargebacks are absorbed by the platform recipient (`liable`). The debit and the alert appear automatically.
- A refunded or charged-back payment stops blocking withdrawals and the finance overview once its debit is in the ledger and the account ledger is not negative. If the couple already withdrew and the ledger is negative, withdrawals stay blocked until later gifts cover it, or until an operator settles the difference and resolves the `GIFT_REFUNDED` / `GIFT_CHARGEBACK` alert with a note (`resolved_at` set), which is the explicit write-off.
- Open alerts: `SELECT * FROM financial_operator_alert WHERE resolved_at IS NULL ORDER BY created_at;`

## Database migrations

Apply schema changes only with `bun run db:migrate`, never `drizzle-kit push`. Migration 0031 adds the Pagar.me withdrawal-observation check as `NOT VALID` so rows written before the switch keep their identifiers; Drizzle cannot express `NOT VALID`, and a push would try to validate it against those rows.

Rows from before the switch are kept: the previous provider's receiving accounts (with their encrypted sub-account credentials and webhook state), withdrawal-authorization custody and Pix preparation rows. Code reads only `PAGARME` accounts for setup and nomination; naming a new holder turns the old account into history (`is_current = false`). Withdrawal history still lists withdrawals made through the old account, and recovery leaves its in-flight withdrawals to an operator. Before running 0031 in production, confirm the old sub-account balances are zero or export the encrypted credentials.

## Sandbox

`tsx apps/api/scripts/pagarmeSandboxProbe.ts [recipient|order|all] [--recipient rp_…]`, run with `PAGARME_MODE=test`, `sk_test_` and the platform `rp_`, plus either `PAGARME_PUBLIC_KEY` (`pk_test_`) or `PAGARME_TEST_CARD_TOKEN`:

- `recipient` creates an individual recipient (automatic anticipation on, transfers off) and checks that the KYC link expires in about 20 minutes.
- `order` places a R$ 100,00 gift in 6x with the split and prints each recipient's payables for the charge. If the couple's total equals `C`, keep `charge_total`; if each installment equals `C`, switch to `per_installment`. Record the result here.

The script never prints keys, tokens or card data.

Confirm once in the sandbox before go-live (the 2026-11 docs review left these open):

- Recipient `birthdate` is sent as `DD/MM/YYYY`, as in the [create recipient](https://docs.pagar.me/reference/criar-recebedor-1) examples; the format is not stated explicitly.
- Whether `transfer_settings.transfer_interval` is case-sensitive (`Daily` in examples, `daily` in the update page).
- Whether a transfer's `fee` is charged on top of `amount` (assumed) or deducted from it.
- Which recipient id format a transfer's `source_id` echoes. Any of the recipient's own ids (`id`, `payment_profile_id`, `gateway_recipients[].pgid`) is accepted; an id the recipient read does not list is refused and leaves the hold to an operator.
- The sort order of `GET /transfers` and how `x-cursor-nextpage` is followed; only the first page is read today.
- Whether a PSP account may pay orders with `card_token`: the [order reference](https://docs.pagar.me/reference/criar-pedido-2) reserves it for Gateway clients and recommends `card_id` for PSP, and says a token order must resend `billing_address`, which the checkout does not collect.
- Whether `POST /orders` and `POST /recipients` honour `Idempotency-Key`; it is documented only for `POST /transfers`. Orders are recovered with `GET /orders?code=` regardless.

Test cards (Pagar.me v5 simulator):

| Card | Result |
|---|---|
| `4000000000000010` | approved |
| `4000000000000028` | declined (`order.payment_failed`) |
| `4000000000000069` | approved, then chargeback |

The simulator does not accept Pix with a split. Test Pix end to end without a split; Pix with a split is covered by the payload tests.
