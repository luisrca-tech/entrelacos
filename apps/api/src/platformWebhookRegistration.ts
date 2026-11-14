import { createHash } from "node:crypto";
import type { GiftPaymentConfig } from "./giftPaymentConfig";

// Events the platform (main) account notifies for PLATFORM_ACCOUNT_SPLIT_V2
// charges. Keep this the single source of truth for the platform webhook.
export const platformWebhookEvents = Object.freeze([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_ANTICIPATED",
  "PAYMENT_SPLIT_DONE",
  "PAYMENT_SPLIT_CANCELLED",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
  "CHECKOUT_CREATED",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "CHECKOUT_PAID",
  "RECEIVABLE_ANTICIPATION_CREDITED",
  "RECEIVABLE_ANTICIPATION_DENIED",
  "RECEIVABLE_ANTICIPATION_CANCELLED",
] as const);

export interface PlatformWebhookRegistrationInput {
  /** Raw ASAAS_PLATFORM_WEBHOOK_TOKEN; must hash to the configured value. */
  platformWebhookToken: string;
  /** ASAAS_WEBHOOK_NOTIFICATION_EMAIL, sent only when present. */
  notificationEmail?: string;
}

export interface PlatformWebhookRegistrationOptions {
  /** false (default) only reads provider state and reports the plan. */
  apply?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface PlatformWebhookRegistrationResult {
  action: "CREATE" | "UPDATE";
  state: "PLANNED" | "REGISTERED" | "UNKNOWN";
  providerWebhookId: string | null;
  name: string;
  url: string;
  eventCount: number;
}

/**
 * Error with a sanitized, operator-facing code. Messages never contain the
 * API key, webhook token, notification email or provider response bodies.
 */
export class PlatformWebhookRegistrationError extends Error {
  constructor(readonly code: string) {
    super(`Platform webhook registration failed: ${code}`);
    this.name = "PlatformWebhookRegistrationError";
  }
}

function fail(code: string): never {
  throw new PlatformWebhookRegistrationError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Provider error codes are short identifiers; anything else is dropped. */
function providerErrorCodes(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) => (entry as { code?: unknown } | null)?.code)
    .filter(
      (code): code is string =>
        typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code),
    )
    .slice(0, 5);
}

// Operator-only operation for the platform (main) account webhook.
// Lists the account's webhooks, updates the one owned by this URL or
// creates it. There is no durable state: a later run reconciles by URL.
export async function registerPlatformWebhook(
  config: GiftPaymentConfig,
  input: PlatformWebhookRegistrationInput,
  options: PlatformWebhookRegistrationOptions = {},
): Promise<PlatformWebhookRegistrationResult> {
  if (
    config.mode === "disabled" ||
    !(
      (config.mode === "sandbox" &&
        config.applicationEnvironment === "development") ||
      (config.mode === "live" && config.applicationEnvironment === "production")
    )
  )
    return fail("ENVIRONMENT_UNSUPPORTED");
  const mode = config.mode;
  const apiKey = config.platformApiKey;
  if (!apiKey.startsWith(mode === "live" ? "$aact_prod_" : "$aact_hmlg_"))
    return fail("API_KEY_MODE_MISMATCH");
  const token = input.platformWebhookToken;
  if (
    typeof token !== "string" ||
    !/^[!-~]{32,255}$/.test(token) ||
    token === apiKey ||
    hash(token) !== config.platformWebhookTokenHash
  )
    return fail("WEBHOOK_TOKEN_INVALID");
  const email = input.notificationEmail;
  if (
    email !== undefined &&
    (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
    return fail("NOTIFICATION_EMAIL_INVALID");
  const origin = new URL(config.webhookPublicOrigin);
  const url = `${origin.origin}/v1/webhooks/asaas`;
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.webhookPublicOrigin ||
    config.webhookUrl !== url
  )
    return fail("WEBHOOK_URL_INVALID");
  const name = `entrelacos-platform-${mode}`;
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl =
    mode === "live" ? "https://api.asaas.com" : "https://api-sandbox.asaas.com";

  async function request(
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v3${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Entrelacos/1.0",
          access_token: apiKey,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail(`PROVIDER_UNREACHABLE_${method}`);
    }
    const text = await response.text().catch(() => "");
    if (text.length > 262_144) return fail("PROVIDER_RESPONSE_TOO_LARGE");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status !== 200 || response.redirected) {
      const codes = providerErrorCodes(parsed);
      return fail(
        `PROVIDER_HTTP_${response.status}_${method}${codes.length ? `:${codes.join(",")}` : ""}`,
      );
    }
    return object(parsed);
  }

  // The key must belong to the configured platform account, never a couple
  // sub-account: its wallet list has to contain the platform wallet.
  const wallets = await request("/wallets/", "GET");
  if (
    !Array.isArray(wallets.data) ||
    !wallets.data.some(
      (wallet) => object(wallet).id === config.platformWalletId,
    )
  )
    return fail("PLATFORM_WALLET_MISMATCH");

  const listed = await request("/webhooks?limit=100", "GET");
  if (
    listed.hasMore !== false ||
    !Array.isArray(listed.data) ||
    listed.data.length > 100
  )
    return fail("WEBHOOK_LIST_INVALID");
  const matching = listed.data
    .map(object)
    // Matched by URL only: one Sandbox platform account can serve several
    // environments (local QA tunnel and Dev), each with its own webhook.
    .filter((webhook) => webhook.url === url);
  if (matching.length > 1) return fail("WEBHOOK_AMBIGUOUS");
  const existing = matching[0];
  if (existing && !reference(existing.id)) return fail("WEBHOOK_LIST_INVALID");
  const existingId = (existing?.id as string | undefined) ?? null;
  const action = existingId ? "UPDATE" : "CREATE";
  const summary = {
    action,
    providerWebhookId: existingId,
    name,
    url,
    eventCount: platformWebhookEvents.length,
  } as const;
  if (!options.apply) return { ...summary, state: "PLANNED" };

  const body = {
    name,
    url,
    ...(email === undefined ? {} : { email }),
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken: token,
    sendType: "SEQUENTIALLY",
    events: platformWebhookEvents,
  };
  function remoteMatches(raw: Record<string, unknown>) {
    return (
      reference(raw.id) &&
      (existingId === null || raw.id === existingId) &&
      raw.name === name &&
      raw.url === url &&
      (email === undefined || raw.email === email) &&
      raw.enabled === true &&
      raw.interrupted === false &&
      raw.apiVersion === 3 &&
      raw.sendType === "SEQUENTIALLY" &&
      (raw.hasAuthToken === undefined || raw.hasAuthToken === true) &&
      (raw.authToken === undefined || raw.authToken === token) &&
      Array.isArray(raw.events) &&
      raw.events.length === platformWebhookEvents.length &&
      platformWebhookEvents.every(
        (event) => Array.isArray(raw.events) && raw.events.includes(event),
      )
    );
  }
  let remote: Record<string, unknown>;
  try {
    remote = existingId
      ? await request(`/webhooks/${existingId}`, "PUT", body)
      : await request("/webhooks", "POST", body);
  } catch (error) {
    // A rejected request (HTTP 4xx) did not apply; anything else is uncertain.
    if (
      error instanceof PlatformWebhookRegistrationError &&
      /^PROVIDER_HTTP_4\d\d_/.test(error.code)
    )
      throw error;
    return { ...summary, state: "UNKNOWN" };
  }
  const remoteId = remote.id;
  if (!reference(remoteId) || (existingId !== null && remoteId !== existingId))
    return { ...summary, state: "UNKNOWN" };
  // The create response may only carry the id; read the stored configuration back.
  let stored: Record<string, unknown>;
  try {
    stored = await request(`/webhooks/${remoteId}`, "GET");
  } catch {
    return { ...summary, state: "UNKNOWN", providerWebhookId: remoteId };
  }
  if (!remoteMatches(stored))
    return { ...summary, state: "UNKNOWN", providerWebhookId: remoteId };
  return { ...summary, state: "REGISTERED", providerWebhookId: remoteId };
}
