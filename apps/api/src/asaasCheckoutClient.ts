import {
  allocateGiftInstallmentCents,
  checkoutCreateInputSchema,
  checkoutResultSchema,
  giftQuoteSchema,
} from "@entrelacos/contracts";
import {
  type AsaasCheckoutPayload,
  type AsaasCheckoutPayloadOptions,
  buildAsaasCheckoutPayload,
  readAsaasCheckoutTerms,
} from "./asaasCheckoutPayload";
import type { AsaasHttpClientOptions } from "./asaasHttpClient";
import {
  type GiftCheckoutProviderCommand,
  type GiftHostedCheckout,
  readGiftQuoteSnapshot,
} from "./giftCheckouts";
import { serializeBrlCents } from "./giftMoney";
import { type GiftQuoteSnapshot, isPlatformAccountSplit } from "./giftQuotes";

// PLATFORM_ACCOUNT_SPLIT_V2 charges are created in the platform (main)
// account with its own API key; no sub-account credential is involved.
export interface AsaasPlatformCheckoutCredentials {
  kind: "PLATFORM_ACCOUNT";
  accessToken: string;
}

// Reconstruct these options from stored server bindings. Matching credential
// metadata alone cannot establish remote ownership, approval or commercial fees.
export interface AsaasCheckoutClientOptions
  extends Omit<AsaasHttpClientOptions, "binding" | "credentials"> {
  binding: GiftQuoteSnapshot["receiving"] & { accountBindingId: string };
  // Sub-account credentials for V1 quotes; the platform key for V2 quotes.
  credentials:
    | AsaasHttpClientOptions["credentials"]
    | AsaasPlatformCheckoutCredentials;
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
// echoes may not contradict our command. Private customer data is discarded.
// No creation response is settlement or split evidence.
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

function hostedCheckoutUrl(
  value: unknown,
  mode: "sandbox" | "live",
  id: string,
): string {
  // ID-only responses remain documented. Preserve complete native links when
  // supplied: Asaas added a variable path segment in September 2026.
  if (value === undefined)
    return mode === "sandbox"
      ? `https://sandbox.asaas.com/checkoutSession/show/${id}`
      : `https://asaas.com/checkoutSession/show?id=${id}`;
  if (
    typeof value !== "string" ||
    /[\s\\]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return unavailable();
  const url = new URL(value);
  const origins =
    mode === "sandbox"
      ? ["https://sandbox.asaas.com"]
      : ["https://asaas.com", "https://www.asaas.com"];
  if (!origins.includes(url.origin) || url.username || url.password || url.hash)
    return unavailable();
  return value;
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
    const credentials = record(options.credentials);
    const platformAccount = credentials.kind !== undefined;
    if (
      platformAccount &&
      (exactRecord(credentials, ["kind", "accessToken"]).kind !==
        "PLATFORM_ACCOUNT" ||
        Object.hasOwn(credentials, "context"))
    )
      return unavailable();
    const context = platformAccount
      ? undefined
      : exactRecord(credentials.context, contextFields);
    const accessToken =
      typeof credentials.accessToken === "string"
        ? credentials.accessToken
        : unavailable();
    const fetch = options.fetch;
    const timeoutMs = options.timeoutMs;
    const maxResponseBytes = options.maxResponseBytes;
    const clock = options.now ?? (() => new Date());
    const keyPrefix = mode === "sandbox" ? "$aact_hmlg_" : "$aact_prod_";
    if (
      suppliedBinding.provider !== "ASAAS" ||
      suppliedBinding.environment !== mode ||
      (context !== undefined &&
        contextFields.some(
          (field) => context[field] !== suppliedBinding[field],
        )) ||
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
      operatorReference: localId(suppliedBinding.operatorReference),
      accountReference: reference(suppliedBinding.accountReference),
      recipientReference: reference(suppliedBinding.recipientReference),
      destinationVersion: Number(suppliedBinding.destinationVersion),
      bankReference: localId(suppliedBinding.bankReference),
    };
    const payloadOptions = structuredClone(options.payload);
    if (payloadOptions.environment !== mode) return unavailable();
    reference(payloadOptions.platformWalletId);
    const base =
      mode === "sandbox"
        ? "https://api-sandbox.asaas.com/v3"
        : "https://api.asaas.com/v3";

    function observedAt(): number {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        return unavailable();
      return now.getTime();
    }

    async function request(
      path: string,
      payload?: object,
      method: "GET" | "POST" | "PUT" | "DELETE" = payload === undefined
        ? "GET"
        : "POST",
    ): Promise<Record<string, unknown>> {
      const url = `${base}${path}`;
      const bodyText =
        payload === undefined ? undefined : JSON.stringify(payload);
      if (
        bodyText?.includes(accessToken) ||
        bodyText?.includes(encodeURIComponent(accessToken))
      )
        return unavailable();
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
            method,
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

    async function createInstallmentInvoice(
      command: GiftCheckoutProviderCommand,
      startedAt: number,
    ) {
      const payer = checkoutCreateInputSchema.shape.payer.parse(command.payer);
      if (!payer) return unavailable();
      const { quote } = readAsaasCheckoutTerms(command, payloadOptions);
      const { installmentCount, installmentCents } = quote;
      if (!installmentCount || installmentCount < 2 || !installmentCents)
        return unavailable();
      const customerResponse = await request("/customers", {
        ...payer,
        notificationDisabled: true,
        externalReference: command.attemptId,
      });
      const customer = reference(customerResponse.id);
      if (
        !customer.startsWith("cus_") ||
        (customerResponse.externalReference !== undefined &&
          customerResponse.externalReference !== command.attemptId)
      )
        return unavailable();
      const currentTime = observedAt();
      // Expiry applies when the reserved operation starts, before creating its customer.
      if (currentTime < startedAt) return unavailable();
      const first = await request("/payments", {
        customer,
        billingType: "CREDIT_CARD",
        dueDate: new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Sao_Paulo",
        }).format(new Date(currentTime)),
        description: quote.title,
        externalReference: command.attemptId,
        installmentCount,
        totalValue: Number(serializeBrlCents(quote.totalCents)),
        // Account-wide late fees must not change the amount the guest accepted.
        interest: { value: 0 },
        fine: { value: 0 },
        split:
          quote.commissionCents === 0
            ? []
            : [
                {
                  walletId: payloadOptions.platformWalletId,
                  totalFixedValue: Number(
                    serializeBrlCents(quote.commissionCents),
                  ),
                },
              ],
      });
      const providerReference = reference(first.installment);
      const firstId = reference(first.id);
      const hostedUrl = hostedCheckoutUrl(
        first.invoiceUrl,
        payloadOptions.environment,
        firstId,
      );
      const invoice = new URL(hostedUrl);
      if (
        invoice.search ||
        !/^\/i\/[A-Za-z0-9_-]{1,128}$/.test(invoice.pathname)
      )
        return unavailable();
      const plan = await request(
        `/installments/${providerReference}/payments?limit=100&offset=0`,
      );
      if (
        plan.hasMore !== false ||
        plan.totalCount !== installmentCount ||
        !Array.isArray(plan.data) ||
        plan.data.length !== installmentCount
      )
        return unavailable();
      const commission = allocateGiftInstallmentCents(
        quote.commissionCents,
        installmentCount,
      );
      const seenIds = new Set<string>();
      const seenNumbers = new Set<number>();
      const validatePayment = (payment: Record<string, unknown>) => {
        const id = reference(payment.id);
        const count = payment.installmentNumber;
        if (
          typeof count !== "number" ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > installmentCount ||
          payment.installment !== providerReference ||
          payment.customer !== customer ||
          payment.externalReference !== command.attemptId ||
          payment.billingType !== "CREDIT_CARD" ||
          payment.status !== "PENDING" ||
          (payment.deleted !== undefined && payment.deleted !== false) ||
          payment.value !==
            Number(serializeBrlCents(installmentCents[count - 1])) ||
          (count === 1 && (id !== firstId || payment.invoiceUrl !== hostedUrl))
        )
          return unavailable();
        const split = payment.split;
        if (commission[count - 1] === 0) {
          if (split != null && (!Array.isArray(split) || split.length !== 0))
            return unavailable();
        } else {
          if (!Array.isArray(split) || split.length !== 1) return unavailable();
          const entry = record(split[0]);
          if (
            entry.walletId !== payloadOptions.platformWalletId ||
            entry.fixedValue !==
              Number(serializeBrlCents(commission[count - 1])) ||
            entry.percentualValue != null
          )
            return unavailable();
        }
        return { id, count };
      };
      if (validatePayment(first).count !== 1) return unavailable();
      for (const raw of plan.data) {
        const payment = validatePayment(record(raw));
        if (seenIds.has(payment.id) || seenNumbers.has(payment.count))
          return unavailable();
        seenIds.add(payment.id);
        seenNumbers.add(payment.count);
      }
      return { providerReference, hostedUrl };
    }

    // PLATFORM_ACCOUNT_SPLIT_V2 card installments. Asaas applies one equal
    // fixed split to every child, which the anticipation of later
    // installments cannot cover, so each child receives its frozen share of
    // the nominal instead. The plan is created with the nominal as
    // totalFixedValue, every child split is updated, and the plan is re-read
    // and verified before an invoice is returned. Any failure after creation
    // removes the whole plan.
    async function createInstallmentInvoiceV2(
      command: GiftCheckoutProviderCommand,
      startedAt: number,
    ) {
      const payer = checkoutCreateInputSchema.shape.payer.parse(command.payer);
      if (!payer) return unavailable();
      const { quote, recipientReference, settlement } = readAsaasCheckoutTerms(
        command,
        payloadOptions,
      );
      const { installmentCount, installmentCents } = quote;
      const recipientSplit = settlement?.recipientSplitCents;
      if (
        !installmentCount ||
        installmentCount < 2 ||
        installmentCents?.length !== installmentCount ||
        recipientSplit?.length !== installmentCount ||
        recipientSplit.reduce((sum, cents) => sum + cents, 0) !==
          quote.nominalCents ||
        recipientReference !== binding.recipientReference
      )
        return unavailable();
      const brl = (cents: number | undefined) =>
        cents === undefined ? unavailable() : Number(serializeBrlCents(cents));
      const customerResponse = await request("/customers", {
        ...payer,
        notificationDisabled: true,
        externalReference: command.attemptId,
      });
      const customer = reference(customerResponse.id);
      if (
        !customer.startsWith("cus_") ||
        (customerResponse.externalReference !== undefined &&
          customerResponse.externalReference !== command.attemptId)
      )
        return unavailable();
      const currentTime = observedAt();
      if (currentTime < startedAt) return unavailable();
      const first = await request("/payments", {
        customer,
        billingType: "CREDIT_CARD",
        dueDate: new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Sao_Paulo",
        }).format(new Date(currentTime)),
        description: quote.title,
        externalReference: command.attemptId,
        installmentCount,
        totalValue: brl(quote.totalCents),
        // Account-wide late fees must not change the amount the guest accepted.
        interest: { value: 0 },
        fine: { value: 0 },
        split: [
          {
            walletId: recipientReference,
            totalFixedValue: brl(quote.nominalCents),
          },
        ],
      });
      const providerReference = reference(first.installment);
      try {
        const firstId = reference(first.id);
        const hostedUrl = hostedCheckoutUrl(
          first.invoiceUrl,
          payloadOptions.environment,
          firstId,
        );
        const invoice = new URL(hostedUrl);
        if (
          invoice.search ||
          !/^\/i\/[A-Za-z0-9_-]{1,128}$/.test(invoice.pathname)
        )
          return unavailable();
        const zeroCharge = (value: unknown) =>
          value == null || record(value).value === 0;
        // Returns the plan's children ordered by installment number.
        const readPlan = async () => {
          const plan = await request(
            `/installments/${providerReference}/payments?limit=100&offset=0`,
          );
          if (
            plan.hasMore !== false ||
            plan.totalCount !== installmentCount ||
            !Array.isArray(plan.data) ||
            plan.data.length !== installmentCount
          )
            return unavailable();
          const ordered: Array<{
            id: string;
            dueDate: string;
            split: unknown;
          }> = [];
          for (const raw of plan.data) {
            const payment = record(raw);
            const id = reference(payment.id);
            const count = payment.installmentNumber;
            if (
              typeof count !== "number" ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > installmentCount ||
              ordered[count - 1] !== undefined ||
              ordered.some((entry) => entry?.id === id) ||
              payment.installment !== providerReference ||
              payment.customer !== customer ||
              payment.externalReference !== command.attemptId ||
              payment.billingType !== "CREDIT_CARD" ||
              payment.status !== "PENDING" ||
              (payment.deleted !== undefined && payment.deleted !== false) ||
              payment.value !== brl(installmentCents[count - 1]) ||
              typeof payment.dueDate !== "string" ||
              !/^\d{4}-\d{2}-\d{2}$/.test(payment.dueDate) ||
              !zeroCharge(payment.fine) ||
              !zeroCharge(payment.interest) ||
              (count === 1 &&
                (id !== firstId || payment.invoiceUrl !== hostedUrl))
            )
              return unavailable();
            ordered[count - 1] = {
              id,
              dueDate: payment.dueDate,
              split: payment.split,
            };
          }
          return ordered;
        };
        const created = await readPlan();
        for (const [index, child] of created.entries()) {
          const updated = await request(
            `/payments/${child.id}`,
            {
              billingType: "CREDIT_CARD",
              value: brl(installmentCents[index]),
              dueDate: child.dueDate,
              split: [
                {
                  walletId: recipientReference,
                  fixedValue: brl(recipientSplit[index]),
                },
              ],
            },
            "PUT",
          );
          if (updated.id !== child.id) return unavailable();
        }
        // Never redirect the guest before the provider confirms every split.
        const verified = await readPlan();
        for (const [index, child] of verified.entries()) {
          const split = child.split;
          if (
            child.id !== created[index]?.id ||
            child.dueDate !== created[index]?.dueDate ||
            !Array.isArray(split) ||
            split.length !== 1
          )
            return unavailable();
          const entry = record(split[0]);
          if (
            entry.walletId !== recipientReference ||
            entry.fixedValue !== brl(recipientSplit[index]) ||
            entry.percentualValue != null
          )
            return unavailable();
        }
        return {
          providerReference,
          hostedUrl,
          installmentPaymentReferences: verified.map(({ id }) => id).sort(),
        };
      } catch {
        try {
          // Same removal as installment expiry: the plan and all its children.
          await request(
            `/installments/${providerReference}`,
            undefined,
            "DELETE",
          );
        } catch {
          // The plan may remain PENDING; no invoice is ever returned for it.
        }
        return unavailable();
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
            ...(Object.hasOwn(command, "payer") ? ["payer"] : []),
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
          // V2 quotes are charged only with the platform key; V1 quotes only
          // with the bound sub-account credential.
          const platformSplit = isPlatformAccountSplit(snapshot);
          if (platformSplit !== platformAccount) return unavailable();
          let providerReference: string;
          let hostedUrl: string;
          let installmentPaymentReferences: string[] | undefined;
          if ((snapshot.quote.installmentCount ?? 1) > 1) {
            const installmentCommand = {
              ...identity,
              quoteSnapshot: snapshot,
              payer: checkoutCreateInputSchema.shape.payer.parse(
                supplied.payer,
              ),
            };
            if (platformSplit) {
              ({ providerReference, hostedUrl, installmentPaymentReferences } =
                await createInstallmentInvoiceV2(
                  installmentCommand,
                  startedAt,
                ));
            } else {
              ({ providerReference, hostedUrl } =
                await createInstallmentInvoice(installmentCommand, startedAt));
            }
          } else {
            if (Object.hasOwn(supplied, "payer")) return unavailable();
            const payload = buildAsaasCheckoutPayload(
              { ...identity, quoteSnapshot: snapshot },
              payloadOptions,
            );
            payload.items[0].name = providerItemName(payload.items[0].name);
            const response = await request("/checkouts", payload);
            providerReference = checkoutReference(response, payload);
            hostedUrl = hostedCheckoutUrl(
              response.link,
              mode,
              providerReference,
            );
          }
          if (observedAt() < startedAt) return unavailable();
          return {
            providerReference,
            ...(installmentPaymentReferences
              ? { installmentPaymentReferences }
              : {}),
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
