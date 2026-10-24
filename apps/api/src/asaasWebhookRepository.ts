import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import {
  type AsaasInboxEvent,
  type AsaasWebhookBinding,
  hashAsaasEventIdentity,
} from "./asaasWebhook";

type WebhookDatabase = Pick<DatabaseConnection["db"], "select" | "transaction">;

export class AsaasWebhookRepositoryError extends Error {
  readonly status = 503;
  readonly code = "WEBHOOK_UNAVAILABLE";
  constructor() {
    super("Webhook persistence unavailable");
    this.name = "AsaasWebhookRepositoryError";
  }
}

function unavailable(): never {
  throw new AsaasWebhookRepositoryError();
}
function reference(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function normalizedEvent(
  event: AsaasInboxEvent,
  environment: "sandbox" | "live",
): AsaasInboxEvent {
  const input = structuredClone(event);
  if (
    input.provider !== "ASAAS" ||
    input.environment !== environment ||
    !reference(input.id) ||
    !reference(input.siteId) ||
    !reference(input.accountId) ||
    !reference(input.providerAccountReference) ||
    !reference(input.providerEventId, 256) ||
    !reference(input.eventType) ||
    !/^[A-Z][A-Z0-9_]+$/.test(input.eventType) ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash) ||
    !input.payload ||
    Array.isArray(input.payload)
  )
    unavailable();
  const allowed = new Set([
    "paymentId",
    "checkoutId",
    "transferId",
    "refundId",
    "accessTokenId",
    "externalReference",
  ]);
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.payload)) {
    if (
      !allowed.has(key) ||
      !reference(value, key === "externalReference" ? 200 : 256)
    )
      unavailable();
    payload[key] = value;
  }
  if (
    input.payloadHash !==
    hashAsaasEventIdentity(
      input.providerEventId,
      input.eventType,
      input.providerAccountReference,
      payload,
    )
  )
    unavailable();
  const observed = new Date(input.receivedAt);
  if (
    !Number.isFinite(observed.getTime()) ||
    observed.toISOString() !== input.receivedAt
  )
    unavailable();
  return {
    id: input.id,
    siteId: input.siteId,
    accountId: input.accountId,
    provider: "ASAAS",
    environment,
    providerAccountReference: input.providerAccountReference,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    payload,
    payloadHash: input.payloadHash,
    receivedAt: input.receivedAt,
  };
}

export function createAsaasWebhookRepository(
  db: WebhookDatabase,
  environment: "sandbox" | "live",
) {
  if (environment !== "sandbox" && environment !== "live") unavailable();
  return {
    async resolveBinding(
      tokenHash: string,
    ): Promise<AsaasWebhookBinding | null> {
      if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
      try {
        const rows = await db
          .select({
            siteId: receivingAccount.siteId,
            accountId: receivingAccount.id,
            provider: receivingAccount.provider,
            providerAccountReference: receivingAccount.accountReference,
            environment: receivingAccount.environment,
            webhookTokenHash: receivingAccount.webhookTokenHash,
            isDemo: site.isDemo,
          })
          .from(receivingAccount)
          .innerJoin(site, eq(site.id, receivingAccount.siteId))
          .where(
            and(
              eq(receivingAccount.webhookTokenHash, tokenHash),
              eq(receivingAccount.environment, environment),
              eq(receivingAccount.provider, "ASAAS"),
            ),
          )
          .limit(2);
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row ||
          row.provider !== "ASAAS" ||
          row.environment !== environment ||
          row.webhookTokenHash !== tokenHash ||
          !reference(row.siteId) ||
          !reference(row.accountId) ||
          !reference(row.providerAccountReference) ||
          typeof row.isDemo !== "boolean"
        )
          return null;
        return {
          siteId: row.siteId,
          accountId: row.accountId,
          provider: "ASAAS",
          providerAccountReference: row.providerAccountReference,
          environment,
          webhookTokenHash: tokenHash,
          isDemo: row.isDemo,
        };
      } catch {
        return unavailable();
      }
    },

    async append(
      event: AsaasInboxEvent,
    ): Promise<"INSERTED" | "DUPLICATE" | "COLLISION"> {
      try {
        const input = normalizedEvent(event, environment);
        return await db.transaction(async (tx) => {
          const accounts = await tx
            .select({
              siteId: receivingAccount.siteId,
              id: receivingAccount.id,
              environment: receivingAccount.environment,
              provider: receivingAccount.provider,
              accountReference: receivingAccount.accountReference,
            })
            .from(receivingAccount)
            .where(
              and(
                eq(receivingAccount.id, input.accountId),
                eq(receivingAccount.siteId, input.siteId),
                eq(receivingAccount.environment, environment),
                eq(receivingAccount.provider, "ASAAS"),
              ),
            )
            .for("share")
            .limit(1);
          const account = accounts[0];
          if (
            !account ||
            account.id !== input.accountId ||
            account.siteId !== input.siteId ||
            account.environment !== environment ||
            account.provider !== input.provider ||
            account.accountReference !== input.providerAccountReference
          )
            unavailable();
          const observed = new Date(input.receivedAt);
          const inserted = await tx
            .insert(financialEventInbox)
            .values({
              id: input.id,
              siteId: input.siteId,
              accountId: input.accountId,
              environment,
              deliveryId: input.id,
              providerEventReference: input.providerEventId,
              eventType: input.eventType,
              payloadHash: input.payloadHash,
              payload: input.payload,
              receivedAt: observed,
              authenticatedAt: observed,
              createdAt: observed,
            })
            .onConflictDoNothing({
              target: [
                financialEventInbox.siteId,
                financialEventInbox.accountId,
                financialEventInbox.environment,
                financialEventInbox.providerEventReference,
              ],
            })
            .returning({ id: financialEventInbox.id });
          if (inserted.length === 1) return "INSERTED";
          if (inserted.length !== 0) unavailable();
          const duplicates = await tx
            .select({ payloadHash: financialEventInbox.payloadHash })
            .from(financialEventInbox)
            .where(
              and(
                eq(financialEventInbox.siteId, input.siteId),
                eq(financialEventInbox.accountId, input.accountId),
                eq(financialEventInbox.environment, environment),
                eq(
                  financialEventInbox.providerEventReference,
                  input.providerEventId,
                ),
              ),
            )
            .limit(1);
          if (duplicates.length !== 1) unavailable();
          return duplicates[0].payloadHash === input.payloadHash
            ? "DUPLICATE"
            : "COLLISION";
        });
      } catch {
        return unavailable();
      }
    },
  };
}
