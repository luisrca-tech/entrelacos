import { isIP } from "node:net";
import { siteIdSchema } from "@entrelacos/contracts";
import type { DatabaseTarget } from "@entrelacos/database";
import type { ProviderCredentialKeyring } from "./providerCredentials";

export type GiftPaymentConfig =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "sandbox" | "live";
      readonly applicationEnvironment: DatabaseTarget;
      readonly liveDemoSiteId?: string;
      readonly platformApiKey: string;
      readonly platformAccountId: string;
      readonly platformWalletId: string;
      readonly credentialKeyId: string;
      readonly credentialKeyring: ProviderCredentialKeyring;
      readonly webhookPublicOrigin: string;
      readonly webhookUrl: string;
      readonly withdrawalAuthorization?: {
        readonly token: string;
        readonly url: string;
      };
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

function reference(value: string | undefined): string {
  const result = required(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) invalid();
  return result;
}

function webhookOrigin(value: string | undefined): string {
  const origin = required(value);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".") ||
    isIP(url.hostname) ||
    /(^|\.)(localhost|localdomain|local|internal)$/i.test(url.hostname)
  )
    invalid();
  return url.origin;
}

export function readGiftPaymentConfig(
  env: Record<string, string | undefined>,
  applicationEnvironment: DatabaseTarget,
): GiftPaymentConfig {
  const mode = env.ASAAS_MODE ?? "disabled";
  const liveDemoSiteId = env.ASAAS_LIVE_DEMO_SITE_ID;
  if (
    liveDemoSiteId !== undefined &&
    (mode !== "live" ||
      applicationEnvironment !== "production" ||
      !siteIdSchema.safeParse(liveDemoSiteId).success)
  )
    invalid();
  if (mode === "disabled") return { mode };
  if (
    (mode !== "sandbox" && mode !== "live") ||
    !["development", "test", "production"].includes(applicationEnvironment) ||
    (mode === "live") !== (applicationEnvironment === "production")
  )
    invalid();
  const platformApiKey = required(env.ASAAS_API_KEY);
  if (Buffer.byteLength(platformApiKey) > 8192) invalid();
  const platformAccountId = reference(env.ASAAS_PLATFORM_ACCOUNT_ID);
  const platformWalletId = reference(env.ASAAS_PLATFORM_WALLET_ID);
  const credentialKeyId = required(env.ASAAS_CREDENTIAL_KEY_ID);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(credentialKeyId)) invalid();
  const encodedKey = required(env.ASAAS_CREDENTIAL_KEY);
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) invalid();
  const webhookPublicOrigin = webhookOrigin(env.ASAAS_WEBHOOK_PUBLIC_ORIGIN);
  const authorizationToken = env.ASAAS_WITHDRAWAL_AUTHORIZATION_TOKEN;
  if (
    authorizationToken !== undefined &&
    !/^[\x21-\x7e]{32,255}$/.test(authorizationToken)
  )
    invalid();
  return {
    mode,
    applicationEnvironment,
    ...(liveDemoSiteId === undefined ? {} : { liveDemoSiteId }),
    platformApiKey,
    platformAccountId,
    platformWalletId,
    credentialKeyId,
    credentialKeyring: new Map([[credentialKeyId, key]]),
    webhookPublicOrigin,
    webhookUrl: `${webhookPublicOrigin}/v1/webhooks/asaas`,
    ...(authorizationToken !== undefined
      ? {
          withdrawalAuthorization: {
            token: authorizationToken,
            url: `${webhookPublicOrigin}/v1/webhooks/asaas/withdrawal-authorization`,
          },
        }
      : {}),
  };
}
