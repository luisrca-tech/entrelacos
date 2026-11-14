# Explicit Asaas payment webhook operation

This operation configures payment and checkout notifications for one existing receiving subaccount. It does not create a subaccount, create a Pix key, initiate a payment or withdrawal, or configure the separate withdrawal-authorization security callback.

## Background processing

The API wakes its financial worker after a webhook insert, hosted checkout save or withdrawal dispatch authorization commits. Inbox events, operation deadlines and payment adjustment deadlines live in PostgreSQL. The worker drains due work on startup and reloads its next deadline from those records. An empty queue sleeps for 30 minutes between safety sweeps. This bounds recovery of a missed signal while the API and database are available and gives Neon time to suspend between sweeps.

Production starts the worker whenever live payments are enabled. Development and test environments start it only with `ASAAS_BACKGROUND_PROCESSING=true` and payments enabled. Run routine integration tests against the local PostgreSQL service.

Withdrawal recovery starts after the original dispatch lease expires. It reserves the next observation for up to five minutes while reading the original transfer, then reschedules unresolved withdrawals. It checks again in 30 seconds during the first ten minutes, in ten minutes during the first hour, and in 30 minutes for older withdrawals. A withdrawal that still requires the first dispatch uses the existing protected confirmation or recovery flow.

When checking Neon suspension, observe compute state in the Neon console without sending SQL to the endpoint. Close public mural and authenticated showcase tabs, since those features still refresh while open. Check that the next actual operation resumes processing and measure network transfer separately.

## Prerequisites

1. Verify the production database identity, Railway environment, receiving site and subaccount. Production accepts a regular site or the exact showcase selected through `ASAAS_LIVE_DEMO_SITE_ID` while `APP_ENV=production` and `ASAAS_MODE=live`. The showcase keeps `is_demo=true`; the opt-in does not authorize other demos or simulated evidence. The compatibility Sandbox operation requires a development demo.
2. Preserve a verified recoverable database checkpoint before the first production configuration. Keep the stable credential key and key ID available so stored subaccount credentials and webhook tokens remain decryptable.
3. Complete the holder's account onboarding and confirm the native account and wallet match the saved receiving binding. The authenticated holder activation flow prepares the incoming Pix key automatically after approval and proof of life; this webhook registrar never creates a key.
4. Deploy the HTTPS API receiver at the configured `ASAAS_WEBHOOK_PUBLIC_ORIGIN` plus `/v1/webhooks/asaas`. Confirm the callback is reachable and its database schema is current. Do not use a development tunnel for production.
5. Review the exact events and callback configuration. The operation subscribes to checkout, payment confirmation/receipt, refund and dispute events. It does not register account-status events or transfer-security authorization.

## Run once with an explicitly selected environment

Inject production secrets directly into the operator process through the approved secret store. Do not modify development `.env` files, print environment values, or pass secrets as shell command arguments.

The process requires `APP_ENV=production`, `ASAAS_MODE=live`, the production `DATABASE_URL`, and the complete Asaas runtime contract from `apps/api/.env.example`. If `RAILWAY_ENVIRONMENT_NAME` is present, it must equal `production`.

For the production showcase, inject `ASAAS_LIVE_DEMO_SITE_ID` with its exact site ID. All account, fee, payment and withdrawal evidence must come from the live provider. Production UI must not show Sandbox or no-real-charge copy. The opt-in does not permit resetting operational data or reseeding fixtures.

Supply these operation-specific settings:

| Variable | Meaning |
| --- | --- |
| `ENTRELACOS_WEBHOOK_SITE_ID` | Exact receiving site ID |
| `ENTRELACOS_WEBHOOK_ACCOUNT_ID` | Exact local receiving-account binding ID, not the native Asaas account ID |
| `ASAAS_WEBHOOK_NOTIFICATION_EMAIL` | Approved notification destination |
| `ENTRELACOS_WEBHOOK_CONFIRM` | Exact phrase `REGISTER production webhook <siteId> <accountId>` using those local IDs |

With the production environment already injected, run from the repository root:

```sh
bun run --cwd apps/api tsx scripts/registerAsaasWebhook.ts
```

This command does not load local dotenv files. It verifies the selected database identity before accessing the registration operation. The existing `scripts/registerSandboxWebhook.ts` remains restricted to development/Sandbox.

## Interpret and recover

`REGISTERED` means the native webhook configuration matches the owned marker, URL, notification destination, enabled state, sequential delivery mode, token and exact event set. It does not prove authentic webhook delivery or financial settlement. Retain the returned provider webhook ID and validate one genuine delivery independently before the pilot.

The operation stores an encrypted, account-bound token and its authentication hash before the first possible native creation. Its durable states are `PREPARED`, `ARMED`, `UPDATING` and `REGISTERED`.

`UNKNOWN` exits unsuccessfully and preserves that state. An uncertain creation is never retried as another `POST`, including when no webhook appears in the current remote list. Run the same scoped operation to reconcile the saved state: it lists the native configurations and can update exactly one matching owned ID with `PUT`, retaining the original token. If no matching remote configuration exists after an armed creation, the state remains unknown for operator investigation. Do not clear the stored marker, token hash or registration object to force a new creation.

Unrelated or conflicting native webhooks are rejected. Never overwrite another system's webhook to satisfy this operation. Updating an owned interrupted queue re-enables pending deliveries; correct receiver availability first. A failed operation prints a sanitized classification, not database credentials, native error bodies or tokens.

Do not restore a database checkpoint over financial events accepted after that checkpoint. Native payments and transfers survive a database rewind. Preserve event evidence, stop new financial commands when necessary, and reconcile or repair forward.

## Platform-account webhook (PLATFORM_ACCOUNT_SPLIT_V2)

Gift charges created under `PLATFORM_ACCOUNT_SPLIT_V2` belong to the platform (main) Asaas account and split a fixed value to the couple sub-account wallet. Their notifications come from one webhook registered on the platform account. It targets the same route, `POST ${ASAAS_WEBHOOK_PUBLIC_ORIGIN}/v1/webhooks/asaas`, as the sub-account webhooks.

### Environment

| Variable | Meaning |
| --- | --- |
| `ASAAS_API_KEY` | Platform account key. Sandbox keys start with `$aact_hmlg_` and live keys with `$aact_prod_`. Registration refuses a key whose prefix does not match `ASAAS_MODE`. |
| `ASAAS_PLATFORM_ACCOUNT_ID` | Native ID of the platform account. Platform events whose `account.id` differs are rejected with `400`. |
| `ASAAS_PLATFORM_WALLET_ID` | Platform wallet ID. Registration only proceeds if the key's `GET /v3/wallets` lists this wallet, so a couple sub-account key cannot be used by mistake. |
| `ASAAS_PLATFORM_WEBHOOK_TOKEN` | Webhook `authToken`: 32–255 printable ASCII characters with no spaces. Generate a distinct random value for each environment, for example `openssl rand -base64 48`. It must not be an Asaas API key. The API retains only its SHA-256 hash. |
| `ASAAS_WEBHOOK_NOTIFICATION_EMAIL` | Optional notification destination. Sent as `email` when present. Asaas documents `email` as required, so set it if creation is rejected. |

Rotating `ASAAS_PLATFORM_WEBHOOK_TOKEN` requires deploying the API with the new value and then running the registration again with `--apply`. Platform deliveries fail with `401` until both steps are complete.

### Register

`.env` values start with `$aact_`, and Bun's dotenv loader expands `$`. Run the script through tsx with Node's `--env-file`, never with `bun run`. From `apps/api`, a dry run lists the platform webhooks and prints whether it would `CREATE` or `UPDATE`:

```sh
node_modules/.bin/tsx --env-file=.env scripts/registerPlatformAsaasWebhook.ts
node_modules/.bin/tsx --env-file=.env scripts/registerPlatformAsaasWebhook.ts --apply
```

`--apply` updates the webhook that matches the URL or the name `entrelacos-platform-<mode>` with `PUT`, or creates it with `POST`. It then reads the configuration back. More than one match is refused. `REGISTERED` means the stored configuration matches. `UNKNOWN` exits with status 1. In that case, run the dry run before another `--apply`, because an uncertain `POST` may have created the webhook. Failures print a sanitized code, such as `PROVIDER_HTTP_400_POST:<asaas error codes>`, and never the key, token or email. In production, inject the environment from the secret store with `APP_ENV=production` and `ASAAS_MODE=live` instead of using a file.

### Events

The list is defined once as `platformWebhookEvents` in `apps/api/src/platformWebhookRegistration.ts`:

`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_ANTICIPATED`, `PAYMENT_SPLIT_DONE`, `PAYMENT_SPLIT_CANCELLED`, `PAYMENT_SPLIT_DIVERGENCE_BLOCK`, `PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED`, `PAYMENT_DELETED`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`, `CHECKOUT_CREATED`, `CHECKOUT_CANCELED`, `CHECKOUT_EXPIRED`, `CHECKOUT_PAID`, `RECEIVABLE_ANTICIPATION_CREDITED`, `RECEIVABLE_ANTICIPATION_DENIED`, `RECEIVABLE_ANTICIPATION_CANCELLED`.

### Routing

- A request is a platform event when the SHA-256 of its `asaas-access-token` header equals the hash of `ASAAS_PLATFORM_WEBHOOK_TOKEN`. Any other token is resolved against the sub-account bindings, as before.
- The event's `account.id` must equal `ASAAS_PLATFORM_ACCOUNT_ID`.
- The charge's `externalReference` is the gift checkout attempt ID. The event is routed to that attempt's site and receiving account. A routed attempt must agree with the `externalReference`.
- An event that cannot be routed is still acknowledged with `200`, so Asaas does not interrupt the queue. The API also opens an `UNROUTABLE_PLATFORM_EVENT` operator alert in `financial_operator_alert`. Investigate each alert.

### Coexistence with V1

Sub-account webhooks keep running. Charges created before the switch (`PLATFORM_FEE_GUARANTEE_V1`) live in the couple sub-accounts and still settle through those webhooks and the platform-adjustment worker. Do not disable or delete a sub-account webhook while the V1 inventory still lists open attempts for that account. To list them, run from `apps/api`:

```sh
node_modules/.bin/tsx --env-file-if-exists=../../packages/database/.env --env-file-if-exists=.env scripts/listV1OpenSettlements.ts [--environment sandbox|live]
```

The inventory runs in a read-only transaction. It lists attempts with installment plans that are not fully received, unfunded platform adjustments, or hosted checkouts that are still open. It prints only IDs, counts and amounts.

## Listening

Webhook setup remains an explicit operator action because a read or refresh must not create provider resources. The generic operation reuses the existing durable registration protocol and retains the development-only wrapper for historical tooling. Incoming Pix-key preparation belongs to the authenticated holder activation flow and its separate durable dispatch fence. Account-status subscriptions remain excluded; missing native prerequisites continue to block readiness.

The provider contracts are documented in [create webhook](https://docs.asaas.com/reference/criar-novo-webhook), [list webhooks](https://docs.asaas.com/reference/listar-webhooks), [update webhook](https://docs.asaas.com/reference/atualizar-webhook-existente), and [create Pix key](https://docs.asaas.com/reference/criar-uma-chave).
