# Explicit Asaas payment webhook operation

This operation configures payment and checkout notifications for one existing receiving subaccount. It does not create a subaccount, create a Pix key, initiate a payment or withdrawal, or configure the separate withdrawal-authorization security callback.

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

## Listening

Webhook setup remains an explicit operator action because a read or refresh must not create provider resources. The generic operation reuses the existing durable registration protocol and retains the development-only wrapper for historical tooling. Incoming Pix-key preparation belongs to the authenticated holder activation flow and its separate durable dispatch fence. Account-status subscriptions remain excluded; missing native prerequisites continue to block readiness.

The provider contracts are documented in [create webhook](https://docs.asaas.com/reference/criar-novo-webhook), [list webhooks](https://docs.asaas.com/reference/listar-webhooks), [update webhook](https://docs.asaas.com/reference/atualizar-webhook-existente), and [create Pix key](https://docs.asaas.com/reference/criar-uma-chave).
