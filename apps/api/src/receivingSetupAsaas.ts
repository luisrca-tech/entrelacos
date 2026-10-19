import type { AsaasAccountProvisioningClientOptions } from "./asaasAccountProvisioningClient";
import type { ProviderCredentialContext } from "./providerCredentials";

export class ReceivingSetupProviderError extends Error {
  readonly status = 503;
  readonly code = "RECEIVING_SETUP_PROVIDER_UNAVAILABLE";
  constructor() {
    super("Receiving setup provider unavailable");
  }
}
function unavailable(): never {
  throw new ReceivingSetupProviderError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
function credential(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > 8192 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return unavailable();
  return value;
}
// The documented creation response supplies these three facts; no approval is inferred.
export const normalizeReceivingSetupAsaasAccount: NonNullable<
  AsaasAccountProvisioningClientOptions["normalizeOriginalResult"]
> = async (body, parent) => {
  try {
    const raw = object(body);
    const accountReference = reference(raw.id);
    if (accountReference === parent.parentAccountReference)
      return unavailable();
    return {
      accountReference,
      recipientReference: reference(raw.walletId),
      credential: credential(raw.apiKey),
    };
  } catch {
    return unavailable();
  }
};
export type ReceivingSetupAsaasStatus =
  | "PENDING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED";
export interface ReceivingSetupAsaasObservation {
  siteId: string;
  accountBindingId: string;
  environment: "sandbox" | "live";
  accountReference: string;
  recipientReference: string;
  observedAt: string;
  status: {
    id: string;
    commercialInfo: ReceivingSetupAsaasStatus;
    bankAccountInfo: ReceivingSetupAsaasStatus;
    documentation: ReceivingSetupAsaasStatus;
    general: ReceivingSetupAsaasStatus;
  };
  commercialInfoExpired: boolean | null;
  // Internal authenticated facts. Setup HTTP projections never serialize these.
  verificationFacts?: {
    commercialInfo: Record<string, unknown>;
    accountNumber: { agency: string; account: string; accountDigit: string };
    activePixKey: { id: string; status: "ACTIVE"; type: string };
  };
}
export interface ReceivingSetupAsaasObserverOptions {
  binding: ProviderCredentialContext & {
    accountReference: string;
    recipientReference: string;
  };
  accessToken: string;
  fetch: typeof globalThis.fetch;
  now(): Date;
  includeVerificationFacts?: boolean;
}
function status(value: unknown): ReceivingSetupAsaasStatus {
  if (
    !["PENDING", "AWAITING_APPROVAL", "APPROVED", "REJECTED"].includes(
      value as string,
    )
  )
    return unavailable();
  return value as ReceivingSetupAsaasStatus;
}
async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const buffer = new Uint8Array(65536);
    let length = 0;
    while (true) {
      if (signal.aborted) return unavailable();
      const chunk = await reader.read();
      if (signal.aborted) return unavailable();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > buffer.byteLength) {
        cancel();
        return unavailable();
      }
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
// Status is useful for onboarding. It does not identify a verified withdrawal bank,
// prove commercial entitlement or grant catalog/checkout/withdrawal authority.
export function createReceivingSetupAsaasObserver(
  options: ReceivingSetupAsaasObserverOptions,
) {
  const binding = Object.freeze({ ...options.binding });
  if (
    binding.provider !== "ASAAS" ||
    !["sandbox", "live"].includes(binding.environment)
  )
    return unavailable();
  for (const value of [
    binding.siteId,
    binding.accountBindingId,
    binding.accountReference,
    binding.recipientReference,
  ])
    reference(value);
  let accessToken = credential(options.accessToken);
  const fetch = options.fetch.bind(undefined);
  const now = options.now.bind(options);
  const base =
    binding.environment === "sandbox"
      ? "https://api-sandbox.asaas.com/v3"
      : "https://api.asaas.com/v3";
  const pending = new Map<
    AbortController,
    Promise<ReceivingSetupAsaasObservation>
  >();
  let closed = false;
  async function get(path: string, signal: AbortSignal) {
    if (closed || signal.aborted) return unavailable();
    const response = await fetch(`${base}${path}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        "User-Agent": "Entrelacos/1.0",
        access_token: accessToken,
      },
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => {});
      return unavailable();
    }
    return object(await readBoundedJson(response, signal));
  }
  return Object.freeze({
    readStatus(signal?: AbortSignal): Promise<ReceivingSetupAsaasObservation> {
      if (closed || signal?.aborted)
        return Promise.reject(new ReceivingSetupProviderError());
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 15000);
      const work = (async () => {
        try {
          const wallets = await get("/wallets/", abort.signal);
          if (
            !Array.isArray(wallets.data) ||
            wallets.data.length !== 1 ||
            wallets.hasMore === true ||
            reference(object(wallets.data[0]).id) !== binding.recipientReference
          )
            return unavailable();
          const raw = await get("/myAccount/status/", abort.signal);
          const observedStatus = {
            id: reference(raw.id),
            commercialInfo: status(raw.commercialInfo),
            bankAccountInfo: status(raw.bankAccountInfo),
            documentation: status(raw.documentation),
            general: status(raw.general),
          };
          const commercial = await get(
            "/myAccount/commercialInfo/",
            abort.signal,
          );
          const expiration = commercial.commercialInfoExpiration;
          const isExpired =
            expiration === undefined || expiration === null
              ? null
              : object(expiration).isExpired;
          if (isExpired !== null && typeof isExpired !== "boolean")
            return unavailable();
          let verificationFacts: ReceivingSetupAsaasObservation["verificationFacts"];
          if (options.includeVerificationFacts === true) {
            if (binding.environment !== "sandbox") return unavailable();
            const accountNumber = await get(
              "/myAccount/accountNumber",
              abort.signal,
            );
            const digits = (value: unknown, max: number) => {
              if (
                typeof value !== "string" ||
                !new RegExp(`^[0-9]{1,${max}}$`).test(value)
              )
                return unavailable();
              return value;
            };
            const keys = await get("/pix/addressKeys?limit=100", abort.signal);
            if (
              !Array.isArray(keys.data) ||
              keys.hasMore !== false ||
              keys.data.length > 100
            )
              return unavailable();
            const active = keys.data
              .map(object)
              .find((key) => key.status === "ACTIVE");
            if (
              !active ||
              !["EVP", "CPF", "CNPJ", "EMAIL", "PHONE"].includes(
                String(active.type),
              )
            )
              return unavailable();
            verificationFacts = {
              commercialInfo: Object.fromEntries(
                [
                  "name",
                  "email",
                  "cpfCnpj",
                  "mobilePhone",
                  "incomeValue",
                  "address",
                  "addressNumber",
                  "province",
                  "postalCode",
                  "birthDate",
                  "status",
                ].map((key) => [key, commercial[key]]),
              ),
              accountNumber: {
                agency: digits(accountNumber.agency, 8),
                account: digits(accountNumber.account, 20),
                accountDigit: digits(accountNumber.accountDigit, 2),
              },
              activePixKey: {
                id: reference(active.id),
                status: "ACTIVE",
                type: String(active.type),
              },
            };
          }
          const observedAt = now();
          if (
            !(observedAt instanceof Date) ||
            !Number.isSafeInteger(observedAt.getTime()) ||
            observedAt.getTime() < 0 ||
            closed ||
            abort.signal.aborted
          )
            return unavailable();
          return {
            siteId: binding.siteId,
            accountBindingId: binding.accountBindingId,
            environment: binding.environment,
            accountReference: binding.accountReference,
            recipientReference: binding.recipientReference,
            observedAt: observedAt.toISOString(),
            status: observedStatus,
            commercialInfoExpired: isExpired,
            ...(verificationFacts ? { verificationFacts } : {}),
          };
        } catch {
          return unavailable();
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
          pending.delete(abort);
        }
      })();
      pending.set(abort, work);
      return work;
    },
    async close() {
      closed = true;
      for (const abort of pending.keys()) abort.abort();
      await Promise.allSettled(pending.values());
      accessToken = "";
    },
  });
}
