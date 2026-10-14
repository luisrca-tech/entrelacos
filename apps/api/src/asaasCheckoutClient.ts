import { checkoutResultSchema, giftQuoteSchema } from "@entrelacos/contracts";
import {
  type AsaasCheckoutPayload,
  type AsaasCheckoutPayloadOptions,
  buildAsaasCheckoutPayload,
} from "./asaasCheckoutPayload";
import type { AsaasHttpClientOptions } from "./asaasHttpClient";
import {
  type GiftCheckoutProviderCommand,
  type GiftHostedCheckout,
  readGiftQuoteSnapshot,
} from "./giftCheckouts";
import type { GiftQuoteSnapshot } from "./giftQuotes";

// Reconstruct these options from stored server bindings. Matching credential
// metadata alone cannot establish remote ownership, approval or commercial fees.
export interface AsaasCheckoutClientOptions
  extends Omit<AsaasHttpClientOptions, "binding"> {
  binding: GiftQuoteSnapshot["receiving"] & { accountBindingId: string };
  payload: AsaasCheckoutPayloadOptions;
}

export interface AsaasCheckoutClient {
  // Only the winning durable checkout reservation may invoke this port. A
  // timeout can follow remote creation; never retry or replace that commitment.
  createHostedCheckout(
    command: GiftCheckoutProviderCommand,
  ): Promise<GiftHostedCheckout>;
}

export class AsaasCheckoutClientError extends Error {
  readonly code = "PROVIDER_CHECKOUT_UNAVAILABLE";
  readonly status = 503;
  readonly title = "Provider checkout is unavailable";

  constructor() {
    super("Provider checkout is unavailable");
    this.name = "AsaasCheckoutClientError";
  }
}

function unavailable(): never {
  throw new AsaasCheckoutClientError();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return unavailable();
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = record(value);
  const ownKeys = Reflect.ownKeys(result);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return unavailable();
  return result;
}

function localId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}

const receivingFields = [
  "siteId",
  "provider",
  "operatorReference",
  "environment",
  "accountReference",
  "recipientReference",
  "destinationVersion",
  "bankReference",
] as const;
const contextFields = [
  "provider",
  "siteId",
  "accountBindingId",
  "environment",
] as const;

function providerItemName(title: string): string {
  if (title.length <= 30) return title;
  let name = "";
  for (const { segment } of new Intl.Segmenter("pt-BR", {
    granularity: "grapheme",
  }).segment(title)) {
    if (name.length + segment.length > 30) break;
    name += segment;
  }
  // A single overlong grapheme cannot fit. Keep a truthful generic label;
  // the full editable gift title and frozen quote remain the source of truth.
  return name.trimEnd() || "Gift";
}

// The documented minimal response contains only an ID. Optional response
// echoes may not contradict our command. Other fields, including link/customer
// data, are discarded. No creation response is settlement or split evidence.
function checkoutReference(
  raw: Record<string, unknown>,
  payload: AsaasCheckoutPayload,
): string {
  const id = reference(raw.id);
  if (raw.status !== undefined && raw.status !== "ACTIVE") return unavailable();
  for (const field of ["externalReference", "minutesToExpire"] as const) {
    if (raw[field] !== undefined && raw[field] !== payload[field])
      return unavailable();
  }
  for (const field of ["billingTypes", "chargeTypes"] as const) {
    if (
      raw[field] !== undefined &&
      (!Array.isArray(raw[field]) ||
        JSON.stringify(raw[field]) !== JSON.stringify(payload[field]))
    )
      return unavailable();
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items) || raw.items.length !== payload.items.length)
      return unavailable();
    raw.items.forEach((item, index) => {
      const echoed = record(item);
      for (const field of ["name", "quantity", "value"] as const) {
        if (echoed[field] !== payload.items[index][field]) unavailable();
      }
    });
  }
  if (raw.callback !== undefined) {
    const callback = record(raw.callback);
    for (const field of ["successUrl", "cancelUrl", "expiredUrl"] as const) {
      if (
        (field !== "expiredUrl" || callback[field] !== undefined) &&
        callback[field] !== payload.callback[field]
      )
        return unavailable();
    }
  }
  if (raw.split !== undefined) {
    if (!Array.isArray(raw.split) || raw.split.length !== payload.splits.length)
      return unavailable();
    raw.split.forEach((split, index) => {
      const echoed = record(split);
      if (
        echoed.walletId !== payload.splits[index].walletId ||
        echoed.fixedValue !== payload.splits[index].fixedValue
      )
        unavailable();
      for (const field of [
        "percentageValue",
        "percentualValue",
        "totalFixedValue",
      ] as const) {
        if (echoed[field] !== undefined && echoed[field] !== null)
          unavailable();
      }
    });
  }
  for (const field of ["subscription", "installment"] as const) {
    if (raw[field] !== undefined && raw[field] !== null) return unavailable();
  }
  return id;
}

export function createAsaasCheckoutClient(
  options: AsaasCheckoutClientOptions,
): AsaasCheckoutClient {
  try {
    const mode = options.mode;
    if (mode !== "sandbox" && mode !== "live") return unavailable();
    const suppliedBinding = exactRecord(options.binding, [
      ...receivingFields,
      "accountBindingId",
    ]);
    const context = exactRecord(options.credentials.context, contextFields);
    const accessToken = options.credentials.accessToken;
    const fetch = options.fetch;
    const timeoutMs = options.timeoutMs;
    const maxResponseBytes = options.maxResponseBytes;
    const clock = options.now ?? (() => new Date());
    const keyPrefix = mode === "sandbox" ? "$aact_hmlg_" : "$aact_prod_";
    if (
      suppliedBinding.provider !== "ASAAS" ||
      suppliedBinding.environment !== mode ||
      contextFields.some(
        (field) => context[field] !== suppliedBinding[field],
      ) ||
      typeof fetch !== "function" ||
      typeof clock !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 1048576 ||
      typeof accessToken !== "string" ||
      accessToken.length > 8192 ||
      accessToken.length <= keyPrefix.length ||
      !/^[\x21-\x7e]+$/.test(accessToken) ||
      !accessToken.startsWith(keyPrefix) ||
      !Number.isSafeInteger(suppliedBinding.destinationVersion) ||
      Number(suppliedBinding.destinationVersion) <= 0
    )
      return unavailable();
    const binding = {
      siteId: giftQuoteSchema.shape.siteId.parse(suppliedBinding.siteId),
      provider: "ASAAS",
      accountBindingId: localId(suppliedBinding.accountBindingId),
      environment: mode,
      operatorReference: reference(suppliedBinding.operatorReference),
      accountReference: reference(suppliedBinding.accountReference),
      recipientReference: reference(suppliedBinding.recipientReference),
      destinationVersion: Number(suppliedBinding.destinationVersion),
      bankReference: reference(suppliedBinding.bankReference),
    };
    const payloadOptions = structuredClone(options.payload);
    if (payloadOptions.environment !== mode) return unavailable();
    reference(payloadOptions.platformWalletId);
    const url =
      mode === "sandbox"
        ? "https://api-sandbox.asaas.com/v3/checkouts"
        : "https://api.asaas.com/v3/checkouts";

    function observedAt(): number {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        return unavailable();
      return now.getTime();
    }

    async function post(bodyText: string): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body: ReadableStream<Uint8Array> | null | undefined;
      let cancelled = false;
      let complete = false;
      const startedAt = performance.now();
      const cancel = () => {
        if (cancelled || !body) return;
        cancelled = true;
        try {
          void (reader ? reader.cancel() : body.cancel()).catch(
            () => undefined,
          );
        } catch {
          /* Cancellation must not expose transport errors. */
        }
      };
      const assertDeadline = () => {
        // Timers can be delayed by a busy event loop. Reject a late ACK even
        // when its promise microtask runs before the timeout callback.
        const elapsed = performance.now() - startedAt;
        if (
          controller.signal.aborted ||
          !Number.isFinite(elapsed) ||
          elapsed < 0 ||
          elapsed >= timeoutMs
        ) {
          controller.abort();
          cancel();
          return unavailable();
        }
      };
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel();
            reject(new AsaasCheckoutClientError());
          }, timeoutMs);
        });
        const operation = (async () => {
          // No retry, alternative endpoint or undocumented idempotency header.
          const response = await fetch(url, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            headers: {
              access_token: accessToken,
              "User-Agent": "EntreLacos-API",
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: bodyText,
            signal: controller.signal,
          });
          body = response.body;
          assertDeadline();
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url && response.url !== url) ||
            !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !body
          )
            return unavailable();
          const length = response.headers.get("content-length");
          if (
            length !== null &&
            (!/^\d+$/.test(length) ||
              !Number.isSafeInteger(Number(length)) ||
              Number(length) > maxResponseBytes)
          )
            return unavailable();
          reader = body.getReader();
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "";
            let bytes = 0;
            for (let chunks = 0; ; chunks++) {
              assertDeadline();
              if (chunks >= 4096) return unavailable();
              const chunk = await reader.read();
              assertDeadline();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > maxResponseBytes) return unavailable();
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
            const result = record(JSON.parse(text));
            assertDeadline();
            complete = true;
            return result;
          } finally {
            if (!complete) cancel();
            reader.releaseLock();
          }
        })();
        const result = await Promise.race([operation, deadline]);
        assertDeadline();
        return result;
      } catch {
        return unavailable();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!complete) cancel();
      }
    }

    return {
      async createHostedCheckout(command): Promise<GiftHostedCheckout> {
        try {
          const supplied = exactRecord(command, [
            "siteId",
            "requestId",
            "orderId",
            "attemptId",
            "quoteSnapshot",
          ]);
          const snapshot = readGiftQuoteSnapshot(
            supplied.quoteSnapshot as GiftQuoteSnapshot,
          );
          const identity = {
            siteId: giftQuoteSchema.shape.siteId.parse(supplied.siteId),
            requestId: localId(supplied.requestId),
            orderId: localId(supplied.orderId),
            attemptId: localId(supplied.attemptId),
          };
          if (
            identity.siteId !== binding.siteId ||
            receivingFields.some(
              (field) => snapshot.receiving[field] !== binding[field],
            )
          )
            return unavailable();
          const startedAt = observedAt();
          if (
            Date.parse(snapshot.createdAt) > startedAt ||
            Date.parse(snapshot.expiresAt) <= startedAt ||
            Date.parse(snapshot.pricing.expiresAt) <= startedAt
          )
            return unavailable();
          const payload = buildAsaasCheckoutPayload(
            { ...identity, quoteSnapshot: snapshot },
            payloadOptions,
          );
          // Project only the PSP display name to its documented 30-character
          // limit. Never mutate the editable gift or its immutable quote title.
          payload.items[0].name = providerItemName(payload.items[0].name);
          const bodyText = JSON.stringify(payload);
          if (
            bodyText.includes(accessToken) ||
            bodyText.includes(encodeURIComponent(accessToken))
          )
            return unavailable();
          const response = await post(bodyText);
          if (observedAt() < startedAt) return unavailable();
          const id = checkoutReference(response, payload);
          // Use each documented hosted form, never a provider-supplied arbitrary
          // link. Browser callbacks and this result grant no financial proof.
          const hostedUrl =
            mode === "sandbox"
              ? `https://sandbox.asaas.com/checkoutSession/show/${id}`
              : `https://asaas.com/checkoutSession/show?id=${id}`;
          return {
            providerReference: id,
            checkout: checkoutResultSchema.parse({
              orderId: identity.orderId,
              attemptId: identity.attemptId,
              quoteId: snapshot.quote.id,
              method: snapshot.quote.method,
              mode,
              hostedUrl,
            }),
          };
        } catch {
          return unavailable();
        }
      },
    };
  } catch {
    return unavailable();
  }
}
