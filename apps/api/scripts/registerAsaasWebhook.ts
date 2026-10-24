import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { readGiftPaymentConfig } from "../src/giftPaymentConfig";
import { registerAsaasWebhook } from "../src/sandboxWebhookRegistration";

export async function runAsaasWebhookRegistration(env: NodeJS.ProcessEnv) {
  const target = env.APP_ENV;
  if (target !== "development" && target !== "production")
    throw new Error("Webhook registration requires an explicit environment");
  if (env.RAILWAY_ENVIRONMENT_NAME && env.RAILWAY_ENVIRONMENT_NAME !== target)
    throw new Error("Webhook registration environment does not match Railway");
  const config = readGiftPaymentConfig(env, target);
  if (
    (target === "production" && config.mode !== "live") ||
    (target === "development" && config.mode !== "sandbox")
  )
    throw new Error("Webhook registration provider mode does not match target");
  const siteId = env.ENTRELACOS_WEBHOOK_SITE_ID;
  const accountId = env.ENTRELACOS_WEBHOOK_ACCOUNT_ID;
  const notificationEmail = env.ASAAS_WEBHOOK_NOTIFICATION_EMAIL;
  if (!siteId || !accountId || !notificationEmail)
    throw new Error("Webhook registration input is required");
  if (
    env.ENTRELACOS_WEBHOOK_CONFIRM !==
    `REGISTER ${target} webhook ${siteId} ${accountId}`
  )
    throw new Error("Exact webhook registration confirmation is required");
  const connection = createDatabaseConnection({ target, env });
  try {
    await verifyDatabaseConnection(connection);
    return await registerAsaasWebhook(connection.db, config, {
      siteId,
      accountId,
      notificationEmail,
    });
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAsaasWebhookRegistration(process.env).then(
    (result) => {
      console.log(
        `Asaas webhook ${result.state}${result.providerWebhookId ? ` (${result.providerWebhookId})` : ""}`,
      );
      if (result.state === "UNKNOWN") process.exitCode = 1;
    },
    () => {
      console.error(
        "Asaas webhook registration failed; inspect saved registration and provider state before another creation attempt",
      );
      process.exitCode = 1;
    },
  );
}
