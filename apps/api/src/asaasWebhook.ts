import { createHash, timingSafeEqual } from "node:crypto";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";

export interface AsaasWebhookBinding {
  siteId: string;
  accountId: string;
  provider: "ASAAS";
  providerAccountReference: string;
  environment: "sandbox" | "live";
  webhookTokenHash: string;
  isDemo: boolean;
}

export interface AsaasInboxEvent {
  id: string;
  siteId: string;
  accountId: string;
  provider: "ASAAS";
  environment: "sandbox" | "live";
  providerAccountReference: string;
  providerEventId: string;
  eventType: string;
  payload: Readonly<Record<string, string>>;
  payloadHash: string;
  receivedAt: string;
}

export interface AsaasWebhookDependencies extends LiveSitePolicy {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  resolveBinding(tokenHash: string): Promise<AsaasWebhookBinding | null>;
  repository: {
    // Atomically deduplicate by provider/account/environment/event ID and compare normalized hash.
    append(
      event: Readonly<AsaasInboxEvent>,
    ): Promise<"INSERTED" | "DUPLICATE" | "COLLISION">;
  };
  now(): Date;
  generateId(): string;
}

export class AsaasWebhookError extends Error {
  constructor(
    readonly status: 400 | 401 | 503,
    readonly code:
      | "WEBHOOK_INVALID"
      | "WEBHOOK_AUTH_DENIED"
      | "WEBHOOK_UNAVAILABLE",
  ) {
    super(
      code === "WEBHOOK_UNAVAILABLE"
        ? "Webhook unavailable"
        : "Webhook rejected",
    );
    this.name = "AsaasWebhookError";
  }
}

function reject(
  status: 400 | 401 | 503,
  code: AsaasWebhookError["code"],
): never {
  throw new AsaasWebhookError(status, code);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reference(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function sameHash(left: string, right: unknown): boolean {
  return (
    typeof right === "string" &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export function hashAsaasEventIdentity(
  eventId: string,
  eventType: string,
  accountReference: string,
  payload: Readonly<Record<string, string>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        eventId,
        eventType,
        accountReference,
        Object.keys(payload)
          .sort()
          .map((key) => [key, payload[key]]),
      ]),
    )
    .digest("hex");
}

export function createAsaasWebhookReceiver(
  dependencies: AsaasWebhookDependencies,
) {
  const mode = dependencies.mode;
  const environment = dependencies.applicationEnvironment;
  const liveDemoSiteId = dependencies.liveDemoSiteId;
  return {
    async receive(
      token: unknown,
      rawBody: unknown,
    ): Promise<{ accepted: true }> {
      try {
        if (
          (mode !== "sandbox" && mode !== "live") ||
          !["development", "test", "production"].includes(environment) ||
          (environment === "production" && mode !== "live")
        ) {
          reject(503, "WEBHOOK_UNAVAILABLE");
        }
        if (
          typeof token !== "string" ||
          token.length < 32 ||
          token.length > 255 ||
          !/^[\x21-\x7e]+$/.test(token)
        )
          reject(401, "WEBHOOK_AUTH_DENIED");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const loaded = await dependencies.resolveBinding(tokenHash);
        const binding = loaded && { ...loaded };
        if (
          binding?.provider !== "ASAAS" ||
          binding.environment !== mode ||
          !sameHash(tokenHash, binding.webhookTokenHash) ||
          !reference(binding.siteId, 128) ||
          !reference(binding.accountId, 128) ||
          !reference(binding.providerAccountReference, 128) ||
          typeof binding.isDemo !== "boolean" ||
          (binding.isDemo &&
            mode === "live" &&
            !allowsLiveSite({
              siteId: binding.siteId,
              isDemo: binding.isDemo,
              mode,
              applicationEnvironment: environment,
              liveDemoSiteId,
            }))
        ) {
          reject(401, "WEBHOOK_AUTH_DENIED");
        }
        if (
          typeof rawBody !== "string" ||
          Buffer.byteLength(rawBody, "utf8") > 65_536
        ) {
          reject(400, "WEBHOOK_INVALID");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          return reject(400, "WEBHOOK_INVALID");
        }
        const event = object(parsed);
        const account = object(event?.account);
        if (
          !event ||
          !reference(event.id) ||
          typeof event.event !== "string" ||
          event.event.length > 128 ||
          !/^[A-Z][A-Z0-9_]+$/.test(event.event) ||
          (event.account !== undefined &&
            account?.id !== binding.providerAccountReference)
        )
          reject(400, "WEBHOOK_INVALID");
        // Only correlation references are retained; consequential effects re-fetch the provider object.
        const payload: Record<string, string> = {};
        for (const [key, field] of [
          ["payment", "paymentId"],
          ["checkout", "checkoutId"],
          ["transfer", "transferId"],
          ["refund", "refundId"],
          ["accessToken", "accessTokenId"],
        ] as const) {
          const entry = object(event[key]);
          if (!entry) continue;
          if (!reference(entry.id)) reject(400, "WEBHOOK_INVALID");
          payload[field] = entry.id;
          if (
            entry.externalReference !== undefined &&
            entry.externalReference !== null
          ) {
            if (!reference(entry.externalReference, 200))
              reject(400, "WEBHOOK_INVALID");
            if (
              payload.externalReference &&
              payload.externalReference !== entry.externalReference
            ) {
              reject(400, "WEBHOOK_INVALID");
            }
            payload.externalReference = entry.externalReference;
          }
        }
        const now = dependencies.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
          reject(503, "WEBHOOK_UNAVAILABLE");
        const id = dependencies.generateId();
        if (!reference(id, 128)) reject(503, "WEBHOOK_UNAVAILABLE");
        const payloadHash = hashAsaasEventIdentity(
          event.id,
          event.event,
          binding.providerAccountReference,
          payload,
        );
        const result = await dependencies.repository.append(
          Object.freeze({
            id,
            siteId: binding.siteId,
            accountId: binding.accountId,
            provider: "ASAAS",
            environment: binding.environment,
            providerAccountReference: binding.providerAccountReference,
            providerEventId: event.id,
            eventType: event.event,
            payload: Object.freeze(payload),
            payloadHash,
            receivedAt: now.toISOString(),
          }),
        );
        if (result !== "INSERTED" && result !== "DUPLICATE")
          reject(503, "WEBHOOK_UNAVAILABLE");
        return { accepted: true };
      } catch (error) {
        if (error instanceof AsaasWebhookError) throw error;
        return reject(503, "WEBHOOK_UNAVAILABLE");
      }
    },
  };
}
