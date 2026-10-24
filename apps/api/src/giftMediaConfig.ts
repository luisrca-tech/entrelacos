import type { DatabaseTarget } from "@entrelacos/database";
import type { R2GiftMediaStorageOptions } from "./giftMediaStorage";

export type GiftMediaConfig =
  | { mode: "disabled" }
  | ({ mode: "r2" } & R2GiftMediaStorageOptions);

function invalid(): never {
  throw new Error("Gift media configuration is invalid");
}

function required(value: string | undefined): string {
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) invalid();
  return value;
}

export function readGiftMediaConfig(
  env: Record<string, string | undefined>,
  applicationEnvironment?: DatabaseTarget,
): GiftMediaConfig {
  const mode = env.GIFT_MEDIA_MODE ?? "disabled";
  if (mode === "disabled") return { mode };
  if (mode !== "r2") invalid();
  const accountId = required(env.R2_ACCOUNT_ID);
  const accessKeyId = required(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY);
  const bucketName = required(env.R2_BUCKET_NAME);
  const publicOrigin = required(env.R2_PUBLIC_ORIGIN);
  const bucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !bucket.test(bucketName)) invalid();
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    return invalid();
  }
  const developmentPublicOrigin =
    (applicationEnvironment === "development" ||
      applicationEnvironment === "test") &&
    /^[a-z0-9-]+\.r2\.dev$/i.test(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".") ||
    (/(^|\.)r2\.dev$/i.test(url.hostname) && !developmentPublicOrigin) ||
    /(^|\.)r2\.cloudflarestorage\.com$/i.test(url.hostname)
  )
    invalid();
  return {
    mode,
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicOrigin: url.origin,
    ...(applicationEnvironment ? { applicationEnvironment } : {}),
  };
}
