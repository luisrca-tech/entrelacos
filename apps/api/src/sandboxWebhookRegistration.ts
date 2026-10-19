import { createHash, randomBytes } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { giftPaymentRestrictionEvents } from "./giftPaymentRestrictions";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
} from "./providerCredentials";

export const sandboxWebhookEvents = Object.freeze([
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  ...giftPaymentRestrictionEvents,
] as const);
type Database = Pick<DatabaseConnection["db"], "execute" | "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
interface Registration {
  version: 1;
  state: "PREPARED" | "ARMED" | "UPDATING" | "REGISTERED";
  name: string;
  url: string;
  email: string;
  token: ProviderCredentialEnvelope;
  providerWebhookId: string | null;
}
export interface SandboxWebhookRegistrationInput {
  siteId: string;
  accountId: string;
  notificationEmail: string;
}
export interface SandboxWebhookRegistrationResult {
  state: "REGISTERED" | "UNKNOWN";
  providerWebhookId: string | null;
}
function unavailable(): never {
  throw new Error("Sandbox webhook registration unavailable");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
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
function validWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/v1/webhooks/asaas" &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

// This development-only operation prepares a durable secret before dispatch.
// An armed operation may only reconcile remote state; absence never permits another POST.
export async function registerSandboxWebhook(
  db: Database,
  config: GiftPaymentConfig,
  input: SandboxWebhookRegistrationInput,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<SandboxWebhookRegistrationResult> {
  try {
    if (
      config.mode !== "sandbox" ||
      config.applicationEnvironment !== "development"
    )
      return unavailable();
    const origin = new URL(config.webhookPublicOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== config.webhookPublicOrigin ||
      origin.hostname.endsWith(".") ||
      config.webhookUrl !== `${origin.origin}/v1/webhooks/asaas` ||
      !reference(input.siteId) ||
      !reference(input.accountId) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.notificationEmail) ||
      input.notificationEmail.length > 254
    )
      return unavailable();
    const { siteId, accountId, notificationEmail } = input;
    const {
      webhookUrl: url,
      credentialKeyring: keys,
      credentialKeyId,
      platformAccountId,
    } = config;
    const context: ProviderCredentialContext = {
      provider: "ASAAS",
      siteId,
      accountBindingId: accountId,
      environment: "sandbox",
    };
    async function load(tx: Pick<Transaction, "execute">) {
      const result = await tx.execute(
        sql`SELECT a.id,a.site_id AS "siteId",a.provider,a.environment,a.is_current AS "isCurrent",s.is_demo AS "isDemo",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",a.credential_version AS "credentialVersion",a.credential_key_id AS "credentialKeyId",a.credential_nonce AS "credentialNonce",a.credential_ciphertext AS "credentialCiphertext",a.credential_tag AS "credentialTag",a.webhook_token_hash AS "webhookTokenHash",a.webhook_registration AS "webhookRegistration" FROM receiving_account a INNER JOIN site s ON s.id=a.site_id WHERE a.id=${accountId} AND a.site_id=${siteId} AND a.provider='ASAAS' AND a.environment='sandbox' AND a.is_current=true FOR UPDATE OF a`,
      );
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        !row ||
        row.id !== accountId ||
        row.siteId !== siteId ||
        row.provider !== "ASAAS" ||
        row.environment !== "sandbox" ||
        row.isCurrent !== true ||
        row.isDemo !== true ||
        !reference(row.accountReference) ||
        row.accountReference === platformAccountId ||
        !reference(row.recipientReference)
      )
        return unavailable();
      return row;
    }
    const account = await db.transaction(load);
    const accessToken = decryptProviderCredential(
      {
        version: account.credentialVersion,
        keyId: account.credentialKeyId,
        nonce: account.credentialNonce,
        ciphertext: account.credentialCiphertext,
        tag: account.credentialTag,
      } as ProviderCredentialEnvelope,
      context,
      keys,
    );
    const fetch = options.fetch ?? globalThis.fetch;
    async function request(
      path: string,
      method: "GET" | "POST" | "PUT",
      body?: unknown,
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const response = await fetch(
          `https://api-sandbox.asaas.com/v3${path}`,
          {
            method,
            redirect: "error",
            signal: controller.signal,
            headers: {
              accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": "Entrelacos/1.0",
              access_token: accessToken,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        if (response.status !== 200 || response.redirected) {
          await response.body?.cancel().catch(() => {});
          return unavailable();
        }
        reader = response.body?.getReader();
        if (!reader) return unavailable();
        const buffer = new Uint8Array(262_144);
        let length = 0;
        while (true) {
          if (controller.signal.aborted) return unavailable();
          const chunk = await reader.read();
          if (controller.signal.aborted) return unavailable();
          if (chunk.done) break;
          if (length + chunk.value.byteLength > buffer.length) {
            cancel();
            return unavailable();
          }
          buffer.set(chunk.value, length);
          length += chunk.value.byteLength;
        }
        return object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, length),
            ),
          ),
        );
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", cancel);
        reader?.releaseLock();
      }
    }
    const wallets = await request("/wallets/", "GET");
    if (
      !Array.isArray(wallets.data) ||
      wallets.data.length !== 1 ||
      wallets.hasMore !== false ||
      object(wallets.data[0]).id !== account.recipientReference
    )
      return unavailable();
    function readRegistration(row: Record<string, unknown>): Registration {
      const raw = object(row.webhookRegistration);
      if (
        Object.keys(raw).length !== 7 ||
        raw.version !== 1 ||
        !["PREPARED", "ARMED", "UPDATING", "REGISTERED"].includes(
          raw.state as string,
        ) ||
        !validWebhookUrl(raw.url) ||
        raw.email !== notificationEmail ||
        (["REGISTERED", "UPDATING"].includes(raw.state as string)
          ? !reference(raw.providerWebhookId)
          : raw.providerWebhookId !== null)
      )
        return unavailable();
      const token = decryptProviderCredential(
        raw.token as ProviderCredentialEnvelope,
        context,
        keys,
      );
      if (
        !/^[A-Za-z0-9_-]{32,255}$/.test(token) ||
        row.webhookTokenHash !== hash(token) ||
        raw.name !== `entrelacos-sandbox-${hash(token).slice(0, 24)}`
      )
        return unavailable();
      return raw as unknown as Registration;
    }
    async function save(
      tx: Pick<Transaction, "execute">,
      registration: Registration,
      tokenHash: string,
    ) {
      const saved = await tx.execute(
        sql`UPDATE receiving_account SET webhook_token_hash=${tokenHash},webhook_registration=${JSON.stringify(registration)}::jsonb,updated_at=clock_timestamp() WHERE id=${accountId} AND site_id=${siteId} AND provider='ASAAS' AND environment='sandbox' AND account_reference=${account.accountReference} AND is_current=true RETURNING id`,
      );
      if (saved.rows.length !== 1 || saved.rows[0].id !== accountId)
        return unavailable();
    }
    const prepared = await db.transaction(async (tx) => {
      const row = await load(tx);
      if (
        row.accountReference !== account.accountReference ||
        row.recipientReference !== account.recipientReference
      )
        return unavailable();
      if (row.webhookRegistration !== null) return readRegistration(row);
      if (row.webhookTokenHash !== null) return unavailable();
      const token = randomBytes(32).toString("base64url");
      const registration: Registration = {
        version: 1,
        state: "PREPARED",
        name: `entrelacos-sandbox-${hash(token).slice(0, 24)}`,
        url,
        email: notificationEmail,
        token: encryptProviderCredential(token, context, keys, credentialKeyId),
        providerWebhookId: null,
      };
      await save(tx, registration, hash(token));
      return registration;
    });
    const token = decryptProviderCredential(prepared.token, context, keys);
    const tokenHash = hash(token);
    const body = {
      name: prepared.name,
      url,
      email: notificationEmail,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: token,
      sendType: "SEQUENTIALLY",
      events: sandboxWebhookEvents,
    };
    function remoteMatches(raw: Record<string, unknown>) {
      return (
        reference(raw.id) &&
        raw.name === prepared.name &&
        raw.url === url &&
        raw.email === notificationEmail &&
        raw.enabled === true &&
        raw.interrupted === false &&
        raw.hasAuthToken === true &&
        raw.apiVersion === 3 &&
        raw.sendType === "SEQUENTIALLY" &&
        Array.isArray(raw.events) &&
        raw.events.length === sandboxWebhookEvents.length &&
        sandboxWebhookEvents.every(
          (event) => Array.isArray(raw.events) && raw.events.includes(event),
        ) &&
        (raw.authToken === undefined || raw.authToken === token)
      );
    }
    async function settle(remote: Record<string, unknown>) {
      if (!remoteMatches(remote)) return unavailable();
      await db.transaction(async (tx) => {
        const current = readRegistration(await load(tx));
        if (
          hash(decryptProviderCredential(current.token, context, keys)) !==
            tokenHash ||
          (current.providerWebhookId !== null &&
            current.providerWebhookId !== remote.id)
        )
          return unavailable();
        await save(
          tx,
          {
            ...current,
            state: "REGISTERED",
            url,
            providerWebhookId: remote.id as string,
          },
          tokenHash,
        );
      });
      return {
        state: "REGISTERED" as const,
        providerWebhookId: remote.id as string,
      };
    }
    const listed = await request("/webhooks?limit=100", "GET");
    if (
      listed.hasMore !== false ||
      !Array.isArray(listed.data) ||
      listed.data.length > 100
    )
      return unavailable();
    const matching = listed.data
      .map(object)
      .filter(
        (webhook) =>
          webhook.name === prepared.name ||
          webhook.url === url ||
          webhook.id === prepared.providerWebhookId,
      );
    if (matching.length) {
      if (matching.length !== 1) return unavailable();
      const remote = matching[0];
      if (
        !reference(remote.id) ||
        remote.name !== prepared.name ||
        (prepared.providerWebhookId !== null &&
          remote.id !== prepared.providerWebhookId)
      )
        return unavailable();
      await db.transaction(async (tx) => {
        const current = readRegistration(await load(tx));
        if (
          hash(decryptProviderCredential(current.token, context, keys)) !==
            tokenHash ||
          (current.providerWebhookId !== null &&
            current.providerWebhookId !== remote.id)
        )
          return unavailable();
        await save(
          tx,
          {
            ...current,
            state: "UPDATING",
            providerWebhookId: remote.id as string,
          },
          tokenHash,
        );
      });
      try {
        return await settle(
          await request(`/webhooks/${remote.id}`, "PUT", body),
        );
      } catch {
        return { state: "UNKNOWN", providerWebhookId: remote.id as string };
      }
    }
    const armed = await db.transaction(async (tx) => {
      const current = readRegistration(await load(tx));
      if (current.state !== "PREPARED") return false;
      await save(tx, { ...current, state: "ARMED" }, tokenHash);
      return true;
    });
    if (!armed)
      return {
        state: "UNKNOWN",
        providerWebhookId: prepared.providerWebhookId,
      };
    try {
      return await settle(await request("/webhooks", "POST", body));
    } catch {
      return { state: "UNKNOWN", providerWebhookId: null };
    }
  } catch {
    return unavailable();
  }
}
