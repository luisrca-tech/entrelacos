import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  type AsaasAccountFeesObservation,
  type AsaasBalanceObservation,
  type AsaasCheckoutPaymentsObservation,
  type AsaasPaymentObservation,
  createAsaasHttpClient,
} from "./asaasHttpClient";
import type { FinancialAccountBinding } from "./financialOverview";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";
import {
  decryptProviderCredential,
  type ProviderCredentialContext,
  type ProviderCredentialKeyring,
} from "./providerCredentials";

export interface AsaasStoredAccountReaderOptions extends LiveSitePolicy {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  keyring: ProviderCredentialKeyring;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  now(): Date;
}
export interface AsaasStoredAccountReader {
  listCheckoutPayments(
    binding: FinancialAccountBinding,
    checkoutReference: string,
  ): Promise<AsaasCheckoutPaymentsObservation>;
  getAccountFees(
    binding: FinancialAccountBinding,
  ): Promise<AsaasAccountFeesObservation>;
  getPayment(claim: GiftPaymentInboxClaim): Promise<AsaasPaymentObservation>;
  getBalance(
    binding: FinancialAccountBinding,
  ): Promise<AsaasBalanceObservation>;
}
export type AsaasStoredAccountReaderDatabase = Pick<
  DatabaseConnection["db"],
  "execute"
>;
export class AsaasStoredAccountReaderError extends Error {
  readonly status = 503;
  readonly code = "ASAAS_STORED_ACCOUNT_UNAVAILABLE";
  readonly title = "Stored provider account is unavailable";
  constructor() {
    super("Stored provider account is unavailable");
    this.name = "AsaasStoredAccountReaderError";
  }
}
function unavailable(): never {
  throw new AsaasStoredAccountReaderError();
}
function localId(value: unknown): value is string {
  return giftQuoteSchema.shape.siteId.safeParse(value).success;
}
function providerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unavailable();
  return value as Record<string, unknown>;
}
function clock(now: () => Date): Date {
  const value = now();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    return unavailable();
  return new Date(value);
}
function encoded(value: unknown, min: number, max: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return false;
  const bytes = Buffer.from(value, "base64url");
  return (
    bytes.length >= min &&
    bytes.length <= max &&
    bytes.toString("base64url") === value
  );
}

export function createAsaasStoredAccountReader(
  db: AsaasStoredAccountReaderDatabase,
  options: AsaasStoredAccountReaderOptions,
): AsaasStoredAccountReader {
  const keyring = new Map<string, Uint8Array>();
  try {
    const {
      mode,
      applicationEnvironment,
      liveDemoSiteId,
      fetch,
      timeoutMs,
      maxResponseBytes,
      now,
    } = options;
    if (
      !["disabled", "sandbox", "live"].includes(mode) ||
      !["development", "test", "production"].includes(applicationEnvironment) ||
      typeof fetch !== "function" ||
      typeof now !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 1_048_576
    )
      return unavailable();
    for (const [keyId, key] of options.keyring) {
      if (
        !localId(keyId) ||
        !(key instanceof Uint8Array) ||
        key.byteLength !== 32 ||
        keyring.has(keyId)
      )
        return unavailable();
      keyring.set(keyId, Buffer.from(key));
    }
    const execute = db.execute.bind(db);
    function activeMode(): "sandbox" | "live" {
      if (
        mode === "disabled" ||
        (mode === "live" && applicationEnvironment !== "production")
      )
        return unavailable();
      return mode;
    }
    function readBinding(
      value: FinancialAccountBinding,
    ): FinancialAccountBinding {
      const environment = activeMode();
      const binding = exact(structuredClone(value), [
        "provider",
        "siteId",
        "accountBindingId",
        "accountReference",
        "environment",
      ]);
      if (
        binding.provider !== "ASAAS" ||
        !localId(binding.siteId) ||
        !localId(binding.accountBindingId) ||
        !providerId(binding.accountReference) ||
        binding.environment !== environment
      )
        return unavailable();
      return {
        provider: "ASAAS",
        siteId: binding.siteId,
        accountBindingId: binding.accountBindingId,
        accountReference: binding.accountReference,
        environment,
      };
    }
    function readClaim(value: GiftPaymentInboxClaim): GiftPaymentInboxClaim {
      const claim = exact(structuredClone(value), [
        "eventId",
        "siteId",
        "accountId",
        "environment",
        "leaseOwner",
        "leaseToken",
        "attempts",
        "paymentReference",
        "providerAccountReference",
      ]);
      if (
        ![
          claim.eventId,
          claim.siteId,
          claim.accountId,
          claim.leaseOwner,
          claim.leaseToken,
        ].every(localId) ||
        !providerId(claim.paymentReference) ||
        !providerId(claim.providerAccountReference) ||
        claim.environment !== activeMode() ||
        !Number.isSafeInteger(claim.attempts) ||
        (claim.attempts as number) < 1 ||
        (claim.attempts as number) > 100
      )
        return unavailable();
      return claim as unknown as GiftPaymentInboxClaim;
    }
    async function loadClient(
      binding: FinancialAccountBinding,
      claim?: GiftPaymentInboxClaim,
    ) {
      const observed = clock(now);
      const originalClaim = claim
        ? sql`AND EXISTS (SELECT 1 FROM ${financialEventInbox} e WHERE e.id=${claim.eventId}
        AND e.site_id=a.site_id AND e.account_id=a.id AND e.environment=a.environment
        AND e.lease_owner=${claim.leaseOwner} AND e.lease_token=${claim.leaseToken} AND e.attempts=${claim.attempts}
        AND e.payload->>'paymentId'=${claim.paymentReference} AND e.state='CLAIMED' AND e.event_type IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED','PAYMENT_REFUNDED','PAYMENT_PARTIALLY_REFUNDED','PAYMENT_REFUND_IN_PROGRESS','PAYMENT_CHARGEBACK_REQUESTED','PAYMENT_CHARGEBACK_DISPUTE','PAYMENT_AWAITING_CHARGEBACK_REVERSAL') AND e.processed_at IS NULL
        AND e.authenticated_at<=${observed.toISOString()}::timestamptz AND e.authenticated_at<=clock_timestamp() AND e.received_at<=e.authenticated_at
        AND e.lease_expires_at>=${observed.toISOString()}::timestamptz AND e.lease_expires_at>=clock_timestamp())`
        : sql``;
      const result =
        await execute(sql`SELECT a.id AS "accountBindingId", a.site_id AS "siteId", a.environment AS "environment", a.provider AS "provider",
        a.account_reference AS "accountReference", st.is_demo AS "isDemo", a.credential_version AS "credentialVersion", a.credential_key_id AS "credentialKeyId",
        a.credential_nonce AS "credentialNonce", a.credential_ciphertext AS "credentialCiphertext", a.credential_tag AS "credentialTag"
        FROM ${receivingAccount} a INNER JOIN ${site} st ON st.id=a.site_id
        WHERE a.id=${binding.accountBindingId} AND a.site_id=${binding.siteId} AND a.environment=${binding.environment}
          AND a.provider='ASAAS' AND a.account_reference=${binding.accountReference} ${originalClaim}`);
      if (result.rows.length !== 1) return unavailable();
      const row = result.rows[0] as Record<string, unknown>;
      if (
        row.accountBindingId !== binding.accountBindingId ||
        row.siteId !== binding.siteId ||
        row.environment !== binding.environment ||
        row.provider !== "ASAAS" ||
        row.accountReference !== binding.accountReference ||
        typeof row.isDemo !== "boolean" ||
        (mode === "live" &&
          row.isDemo &&
          !allowsLiveSite({
            siteId: binding.siteId,
            isDemo: row.isDemo,
            mode,
            applicationEnvironment,
            liveDemoSiteId,
          })) ||
        row.credentialVersion !== 1 ||
        !localId(row.credentialKeyId) ||
        !keyring.has(row.credentialKeyId) ||
        !encoded(row.credentialNonce, 12, 12) ||
        !encoded(row.credentialCiphertext, 1, 8192) ||
        !encoded(row.credentialTag, 16, 16)
      )
        return unavailable();
      const context: ProviderCredentialContext = {
        provider: "ASAAS",
        siteId: row.siteId as string,
        accountBindingId: row.accountBindingId as string,
        environment: binding.environment,
      };
      const accessToken = decryptProviderCredential(
        {
          version: 1,
          keyId: row.credentialKeyId,
          nonce: row.credentialNonce,
          ciphertext: row.credentialCiphertext,
          tag: row.credentialTag,
        },
        context,
        keyring,
      );
      // Provisioning binds this stored remote reference to its key; decryption does not prove remote ownership or account approval.
      return createAsaasHttpClient({
        mode: activeMode(),
        binding: {
          ...context,
          accountReference: row.accountReference as string,
        },
        credentials: { context, accessToken },
        fetch,
        timeoutMs,
        maxResponseBytes,
        now,
      });
    }
    return {
      async listCheckoutPayments(value, checkoutReference) {
        try {
          activeMode();
          const binding = readBinding(value);
          if (!providerId(checkoutReference)) return unavailable();
          const client = await loadClient(binding);
          return await client.listCheckoutPayments(checkoutReference);
        } catch {
          return unavailable();
        }
      },
      async getAccountFees(
        value: FinancialAccountBinding,
      ): Promise<AsaasAccountFeesObservation> {
        try {
          activeMode();
          const binding = readBinding(value);
          const client = await loadClient(binding);
          return await client.getAccountFees();
        } catch {
          return unavailable();
        }
      },
      async getPayment(
        value: GiftPaymentInboxClaim,
      ): Promise<AsaasPaymentObservation> {
        try {
          activeMode();
          const claim = readClaim(value);
          const binding: FinancialAccountBinding = {
            provider: "ASAAS",
            siteId: claim.siteId,
            accountBindingId: claim.accountId,
            accountReference: claim.providerAccountReference,
            environment: claim.environment,
          };
          const client = await loadClient(binding, claim);
          return await client.getPayment(claim.paymentReference);
        } catch {
          return unavailable();
        }
      },
      async getBalance(
        value: FinancialAccountBinding,
      ): Promise<AsaasBalanceObservation> {
        try {
          activeMode();
          const binding = readBinding(value);
          const client = await loadClient(binding);
          return await client.getBalance();
        } catch {
          return unavailable();
        }
      },
    };
  } catch {
    for (const key of keyring.values()) key.fill(0);
    return unavailable();
  }
}
