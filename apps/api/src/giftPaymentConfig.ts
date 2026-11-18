import { createHash } from "node:crypto";
import { siteIdSchema } from "@entrelacos/contracts";
import type { DatabaseTarget } from "@entrelacos/database";

/**
 * Pagar.me settings. PAGARME_MODE=test is stored as the `sandbox` financial
 * environment and PAGARME_MODE=live as `live`.
 */
export type GiftPaymentConfig =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "sandbox" | "live";
      readonly providerMode: "test" | "live";
      readonly applicationEnvironment: DatabaseTarget;
      readonly backgroundProcessing?: true;
      readonly liveDemoSiteIds?: readonly string[];
      /** Basic auth username for the Pagar.me API (empty password). */
      readonly secretKey: string;
      readonly platformRecipientId: string;
      readonly webhookBasicUser: string;
      /** sha256 hex of `user:password`; the raw password is not retained. */
      readonly webhookCredentialsHash: string;
    };

function invalid(): never {
  throw new Error("Gift payment configuration is invalid");
}

function required(value: string | undefined): string {
  if (
    !value ||
    value !== value.trim() ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}

function secretKey(value: string | undefined, mode: "test" | "live") {
  const key = required(value);
  if (
    key.length > 8192 ||
    !/^sk_[A-Za-z0-9_-]+$/.test(key) ||
    (mode === "test") !== key.startsWith("sk_test_") ||
    key === "sk_test_"
  )
    invalid();
  return key;
}

export function readGiftPaymentConfig(
  env: Record<string, string | undefined>,
  applicationEnvironment: DatabaseTarget,
): GiftPaymentConfig {
  const mode = env.PAGARME_MODE ?? "disabled";
  const liveDemoSiteIds = env.PAGARME_LIVE_DEMO_SITE_ID?.split(",").map((id) =>
    id.trim(),
  );
  if (
    liveDemoSiteIds !== undefined &&
    (mode !== "live" ||
      applicationEnvironment !== "production" ||
      new Set(liveDemoSiteIds).size !== liveDemoSiteIds.length ||
      liveDemoSiteIds.some((id) => !siteIdSchema.safeParse(id).success))
  )
    invalid();
  if (mode === "disabled") return { mode };
  if (
    (mode !== "test" && mode !== "live") ||
    !["development", "test", "production"].includes(applicationEnvironment) ||
    (mode === "live") !== (applicationEnvironment === "production")
  )
    invalid();
  const backgroundProcessing = env.PAGARME_BACKGROUND_PROCESSING;
  if (
    backgroundProcessing !== undefined &&
    backgroundProcessing !== "true" &&
    backgroundProcessing !== "false"
  )
    invalid();
  const key = secretKey(env.PAGARME_SECRET_KEY, mode);
  const platformRecipientId = required(env.PAGARME_PLATFORM_RECIPIENT_ID);
  if (!/^rp_[A-Za-z0-9]{1,128}$/.test(platformRecipientId)) invalid();
  const webhookBasicUser = required(env.PAGARME_WEBHOOK_BASIC_USER);
  if (!/^[!-9;-~]{1,128}$/.test(webhookBasicUser)) invalid();
  const webhookPassword = required(env.PAGARME_WEBHOOK_BASIC_PASSWORD);
  if (!/^[!-~]{32,255}$/.test(webhookPassword)) invalid();
  return {
    mode: mode === "test" ? "sandbox" : "live",
    providerMode: mode,
    applicationEnvironment,
    ...(backgroundProcessing === "true" ? { backgroundProcessing: true } : {}),
    ...(liveDemoSiteIds === undefined ? {} : { liveDemoSiteIds }),
    secretKey: key,
    platformRecipientId,
    webhookBasicUser,
    webhookCredentialsHash: createHash("sha256")
      .update(`${webhookBasicUser}:${webhookPassword}`)
      .digest("hex"),
  };
}
