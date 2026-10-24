import {
  encryptProviderCredential,
  type ProviderCredentialContext,
  type ProviderCredentialKeyring,
} from "./providerCredentials";
import {
  type ReceivingProvisioningResult,
  readReceivingProvisioningResult,
} from "./receivingNomination";

export interface AccountProvisioningInput {
  readonly name: string;
  readonly email: string;
  readonly cpfCnpj: string;
  readonly mobilePhone: string;
  readonly incomeValue: number;
  readonly address: string;
  readonly addressNumber: string;
  readonly province: string;
  readonly postalCode: string;
  readonly birthDate: string;
}
export interface AsaasAccountProvisioningClient {
  readonly available: boolean;
  readonly configuration?: Readonly<{
    environment: "sandbox" | "live";
    parentAccountReference: string;
    credentialContext: Readonly<ProviderCredentialContext>;
  }>;
  readonly credentialKeyIds: readonly string[];
  createOriginal(
    input: AccountProvisioningInput,
    signal?: AbortSignal,
  ): Promise<ReceivingProvisioningResult>;
  close(): Promise<void>;
}
export interface AsaasAccountProvisioningClientOptions {
  environment: "sandbox" | "live";
  parentAccountReference: string;
  parentCredential: string;
  credentialContext: ProviderCredentialContext;
  credentialKeys: ProviderCredentialKeyring;
  activeCredentialKeyId: string;
  fetch: typeof fetch;
  normalizeOriginalResult?: (
    body: unknown,
    parent: Readonly<{
      environment: "sandbox" | "live";
      parentAccountReference: string;
    }>,
  ) => Promise<{
    accountReference: string;
    recipientReference: string;
    credential: string;
  }>;
}
function unavailable(): never {
  throw new Error("Account provisioning unavailable");
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return unavailable();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return unavailable();
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Buffer.byteLength(normalized) > limit)
    return unavailable();
  return normalized;
}
export function readAccountProvisioningInput(
  value: unknown,
): Readonly<AccountProvisioningInput> {
  const raw = exact(value, [
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
  ]);
  if (
    typeof raw.cpfCnpj !== "string" ||
    !/^\d{11}$/.test(raw.cpfCnpj) ||
    typeof raw.mobilePhone !== "string" ||
    !/^\d{10,11}$/.test(raw.mobilePhone) ||
    typeof raw.postalCode !== "string" ||
    !/^\d{8}$/.test(raw.postalCode) ||
    typeof raw.birthDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.birthDate) ||
    !Number.isFinite(Date.parse(raw.birthDate)) ||
    new Date(raw.birthDate).toISOString().slice(0, 10) !== raw.birthDate ||
    typeof raw.incomeValue !== "number" ||
    raw.incomeValue < 0 ||
    Object.is(raw.incomeValue, -0) ||
    !Number.isSafeInteger(raw.incomeValue * 100)
  )
    return unavailable();
  const result = Object.freeze({
    name: text(raw.name, 256),
    email: text(raw.email, 254),
    cpfCnpj: raw.cpfCnpj,
    mobilePhone: raw.mobilePhone,
    incomeValue: raw.incomeValue,
    address: text(raw.address, 256),
    addressNumber: text(raw.addressNumber, 32),
    province: text(raw.province, 256),
    postalCode: raw.postalCode,
    birthDate: raw.birthDate,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) return unavailable();
  return result;
}
async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().then(
      () => {},
      () => {},
    );
  };
  const timer = setTimeout(cancel, 15000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const bytes = new Uint8Array(65536);
    let length = 0;
    while (true) {
      const item = await reader.read();
      if (cancellation) return unavailable();
      if (item.done) break;
      if (
        !(item.value instanceof Uint8Array) ||
        length + item.value.length > bytes.length
      ) {
        cancel();
        return unavailable();
      }
      bytes.set(item.value, length);
      length += item.value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}
export function createAsaasAccountProvisioningClient(
  options?: AsaasAccountProvisioningClientOptions,
): AsaasAccountProvisioningClient {
  const keys = new Map<string, Uint8Array>();
  const inactive = (): AsaasAccountProvisioningClient => {
    for (const key of keys.values()) key.fill(0);
    const closed = Promise.resolve();
    return Object.freeze({
      available: false,
      credentialKeyIds: Object.freeze([]),
      createOriginal: async () => unavailable(),
      close: () => closed,
    });
  };
  let configuration: NonNullable<
    AsaasAccountProvisioningClient["configuration"]
  >;
  let parentCredential: string;
  let activeKeyId: string;
  let fetchOriginal: typeof fetch;
  let normalize: NonNullable<
    AsaasAccountProvisioningClientOptions["normalizeOriginalResult"]
  >;
  try {
    if (!options) return inactive();
    const nativeNormalizer = options.normalizeOriginalResult;
    const nativeFetch = options.fetch;
    if (
      typeof nativeNormalizer !== "function" ||
      typeof nativeFetch !== "function"
    )
      return inactive();
    const environment = options.environment;
    const parentReference = options.parentAccountReference;
    const parentKey = options.parentCredential;
    const contextInput = options.credentialContext;
    const keyring = options.credentialKeys;
    const encryptionKeyId = options.activeCredentialKeyId;
    if (environment !== "sandbox" && environment !== "live") return inactive();
    const context = exact(contextInput, [
      "provider",
      "siteId",
      "accountBindingId",
      "environment",
    ]);
    if (context.provider !== "ASAAS" || context.environment !== environment)
      return inactive();
    configuration = Object.freeze({
      environment,
      parentAccountReference: identifier(parentReference),
      credentialContext: Object.freeze({
        provider: "ASAAS",
        siteId: identifier(context.siteId),
        accountBindingId: identifier(context.accountBindingId),
        environment,
      }),
    });
    if (
      typeof parentKey !== "string" ||
      !parentKey.trim() ||
      Buffer.byteLength(parentKey) > 8192 ||
      /[\r\n\0]/.test(parentKey)
    )
      return inactive();
    parentCredential = parentKey;
    activeKeyId = identifier(encryptionKeyId);
    if (!(keyring instanceof Map) || keyring.size > 32) return inactive();
    for (const [id, key] of keyring) {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32)
        return inactive();
      keys.set(identifier(id), new Uint8Array(key));
    }
    if (!keys.has(activeKeyId)) return inactive();
    fetchOriginal = nativeFetch;
    normalize = nativeNormalizer;
  } catch {
    return inactive();
  }
  let used = false;
  let closing: Promise<void> | undefined;
  const owned = new Set<{
    abort: AbortController;
    completion: Promise<void>;
  }>();
  return Object.freeze<AsaasAccountProvisioningClient>({
    available: true,
    configuration,
    credentialKeyIds: Object.freeze([...keys.keys()]),
    createOriginal(input, signal) {
      if (used || closing || signal?.aborted)
        return Promise.reject(new Error("Account provisioning unavailable"));
      used = true;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      let settled!: () => void;
      const entry = {
        abort,
        completion: new Promise<void>((resolve) => {
          settled = resolve;
        }),
      };
      owned.add(entry);
      return (async () => {
        try {
          const canonical = readAccountProvisioningInput(input);
          if (abort.signal.aborted) return unavailable();
          const response = await fetchOriginal(
            configuration.environment === "sandbox"
              ? "https://api-sandbox.asaas.com/v3/accounts"
              : "https://api.asaas.com/v3/accounts",
            {
              method: "POST",
              redirect: "error",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "Entrelacos/1.0",
                access_token: parentCredential,
              },
              body: JSON.stringify(canonical),
              signal: abort.signal,
            },
          );
          if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel().catch(() => {});
            return unavailable();
          }
          // Returned late bytes still belong to this original one-time operation.
          const result = await normalize(
            await readBody(response, abort.signal),
            configuration,
          );
          const raw = exact(result, [
            "accountReference",
            "recipientReference",
            "credential",
          ]);
          if (typeof raw.credential !== "string") return unavailable();
          return readReceivingProvisioningResult({
            accountReference: raw.accountReference,
            recipientReference: raw.recipientReference,
            credential: encryptProviderCredential(
              raw.credential,
              configuration.credentialContext,
              keys,
              activeKeyId,
            ),
          });
        } catch {
          return unavailable();
        } finally {
          signal?.removeEventListener("abort", cancel);
          owned.delete(entry);
          settled();
        }
      })();
    },
    close() {
      if (closing) return closing;
      let resolve!: () => void;
      closing = new Promise<void>((yes) => {
        resolve = yes;
      });
      for (const entry of owned) entry.abort.abort();
      void Promise.allSettled([...owned].map((entry) => entry.completion)).then(
        () => {
          for (const key of keys.values()) key.fill(0);
          parentCredential = "";
          resolve();
        },
      );
      return closing;
    },
  });
}
