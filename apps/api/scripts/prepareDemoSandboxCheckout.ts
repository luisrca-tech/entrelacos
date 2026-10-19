import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  demoSandboxCheckoutConfirmation,
  prepareDemoSandboxCheckout,
} from "../src/demoSandboxCheckoutSetup";
import { readGiftPaymentConfig } from "../src/giftPaymentConfig";

export async function runDemoSandboxCheckoutPreparation(
  env: NodeJS.ProcessEnv,
) {
  if (
    env.ENTRELACOS_DATABASE_TARGET !== "development" ||
    env.NODE_ENV === "production" ||
    (env.RAILWAY_ENVIRONMENT_NAME &&
      env.RAILWAY_ENVIRONMENT_NAME !== "development")
  )
    throw new Error("Development database target is required");
  if (env.ENTRELACOS_DEMO_CHECKOUT_CONFIRM !== demoSandboxCheckoutConfirmation)
    throw new Error("Explicit checkout simulation confirmation is required");
  const config = readGiftPaymentConfig(env, "development");
  if (config.mode !== "sandbox")
    throw new Error("Sandbox provider mode is required");
  const connection = createDatabaseConnection({ target: "development", env });
  try {
    await verifyDatabaseConnection(connection);
    return await prepareDemoSandboxCheckout(connection.db, config, {
      confirmation: env.ENTRELACOS_DEMO_CHECKOUT_CONFIRM ?? "",
    });
  } finally {
    await connection.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDemoSandboxCheckoutPreparation(process.env)
    .then((result) => {
      console.log(
        `SIMULATION: guest checkout only for ${result.siteId}; evidence expires at ${result.expiresAt}. Native bank approval and withdrawals are not enabled.`,
      );
    })
    .catch(() => {
      console.error(
        "Demo Sandbox checkout preparation failed; verify explicit confirmation, development database identity, actual account, holder consent and webhook setup",
      );
      process.exitCode = 1;
    });
}
