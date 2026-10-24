import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { readGiftPaymentConfig } from "../src/giftPaymentConfig";
import { registerSandboxWebhook } from "../src/sandboxWebhookRegistration";

export async function runSandboxWebhookRegistration(env: NodeJS.ProcessEnv) {
  if (env.APP_ENV !== "development")
    throw new Error("Sandbox webhook registration requires development");
  const config = readGiftPaymentConfig(env, "development");
  if (config.mode !== "sandbox")
    throw new Error("Sandbox webhook registration requires Sandbox");
  const siteId = env.ENTRELACOS_WEBHOOK_SITE_ID;
  const accountId = env.ENTRELACOS_WEBHOOK_ACCOUNT_ID;
  const notificationEmail = env.ASAAS_WEBHOOK_NOTIFICATION_EMAIL;
  if (!siteId || !accountId || !notificationEmail)
    throw new Error("Sandbox webhook registration input is required");
  const connection = createDatabaseConnection({ target: "development", env });
  try {
    await verifyDatabaseConnection(connection);
    return await registerSandboxWebhook(connection.db, config, {
      siteId,
      accountId,
      notificationEmail,
    });
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSandboxWebhookRegistration(process.env).then(
    (result) => {
      console.log(
        `Sandbox webhook ${result.state}${result.providerWebhookId ? ` (${result.providerWebhookId})` : ""}`,
      );
      if (result.state === "UNKNOWN") process.exitCode = 1;
    },
    () => {
      console.error(
        "Sandbox webhook registration failed; inspect saved registration and provider state before another creation attempt",
      );
      process.exitCode = 1;
    },
  );
}
