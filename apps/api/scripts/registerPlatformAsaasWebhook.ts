/**
 * Registers (or updates) the Asaas webhook of the PLATFORM (main) account used
 * by PLATFORM_ACCOUNT_SPLIT_V2 gift charges. Dry-run by default: it only reads
 * the account's wallets and webhooks and prints the intended action. Pass
 * `--apply` to send the PUT/POST.
 *
 * Env loading: `.env` values such as ASAAS_API_KEY start with `$aact_`, and
 * Bun's dotenv loader expands `$` sequences, corrupting them. Run this script
 * with Node's loader through tsx, never `bun run`:
 *
 *   cd apps/api
 *   node_modules/.bin/tsx --env-file=.env scripts/registerPlatformAsaasWebhook.ts
 *   node_modules/.bin/tsx --env-file=.env scripts/registerPlatformAsaasWebhook.ts --apply
 *
 * In production inject the environment from the secret store instead of a file.
 *
 * Required env: APP_ENV (development | production), ASAAS_MODE (sandbox |
 * live, matching APP_ENV), ASAAS_API_KEY (platform key, `$aact_hmlg_` for
 * Sandbox / `$aact_prod_` for live), ASAAS_PLATFORM_ACCOUNT_ID,
 * ASAAS_PLATFORM_WALLET_ID, ASAAS_PLATFORM_WEBHOOK_TOKEN,
 * ASAAS_WEBHOOK_PUBLIC_ORIGIN and the rest of the runtime contract read by
 * readGiftPaymentConfig. Optional: ASAAS_WEBHOOK_NOTIFICATION_EMAIL.
 *
 * Output never contains the API key, webhook token or notification email.
 */
import { fileURLToPath } from "node:url";
import { readGiftPaymentConfig } from "../src/giftPaymentConfig";
import {
  PlatformWebhookRegistrationError,
  registerPlatformWebhook,
} from "../src/platformWebhookRegistration";

export async function runPlatformWebhookRegistration(
  env: NodeJS.ProcessEnv,
  options: { apply: boolean; fetch?: typeof globalThis.fetch },
) {
  const target = env.APP_ENV;
  if (target !== "development" && target !== "production")
    throw new PlatformWebhookRegistrationError("APP_ENV_REQUIRED");
  if (env.RAILWAY_ENVIRONMENT_NAME && env.RAILWAY_ENVIRONMENT_NAME !== target)
    throw new PlatformWebhookRegistrationError("RAILWAY_ENVIRONMENT_MISMATCH");
  let config: ReturnType<typeof readGiftPaymentConfig>;
  try {
    config = readGiftPaymentConfig(env, target);
  } catch {
    throw new PlatformWebhookRegistrationError("CONFIGURATION_INVALID");
  }
  if (
    (target === "production" && config.mode !== "live") ||
    (target === "development" && config.mode !== "sandbox")
  )
    throw new PlatformWebhookRegistrationError("PROVIDER_MODE_MISMATCH");
  const notificationEmail = env.ASAAS_WEBHOOK_NOTIFICATION_EMAIL?.trim();
  return registerPlatformWebhook(
    config,
    {
      platformWebhookToken: env.ASAAS_PLATFORM_WEBHOOK_TOKEN ?? "",
      ...(notificationEmail ? { notificationEmail } : {}),
    },
    options,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  runPlatformWebhookRegistration(process.env, { apply }).then(
    (result) => {
      const id = result.providerWebhookId
        ? ` (${result.providerWebhookId})`
        : "";
      if (result.state === "PLANNED")
        console.log(
          `Dry run: would ${result.action} platform webhook ${result.name}${id} -> ${result.url} with ${result.eventCount} events. Re-run with --apply to perform it.`,
        );
      else
        console.log(
          `Platform webhook ${result.action} ${result.state}${id} -> ${result.url}`,
        );
      if (result.state === "UNKNOWN") {
        console.error(
          "Outcome uncertain; list the platform webhooks (dry run) before another --apply",
        );
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      const code =
        error instanceof PlatformWebhookRegistrationError
          ? error.code
          : "UNEXPECTED";
      console.error(`Platform webhook registration failed: ${code}`);
      process.exitCode = 1;
    },
  );
}
