import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Context must be reconstructed from server-owned account bindings, never a request body.
export interface ProviderCredentialContext {
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  environment: "sandbox" | "live";
}

export interface ProviderCredentialEnvelope {
  readonly version: 1;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export type ProviderCredentialKeyring = ReadonlyMap<string, Uint8Array>;

const MAX_SECRET_BYTES = 8192;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ProviderCredentialServiceError extends Error {
  readonly status = 503;
  readonly code = "PROVIDER_CREDENTIAL_UNAVAILABLE";
  readonly title = "Provider credential is unavailable";

  constructor() {
    super("Provider credential is unavailable");
    this.name = "ProviderCredentialServiceError";
  }
}

function unavailable(): never {
  throw new ProviderCredentialServiceError();
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function exactRecord(
  value: unknown,
  fields: string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    return unavailable();
  }
  return value as Record<string, unknown>;
}

function readContext(
  context: ProviderCredentialContext,
): ProviderCredentialContext {
  const { provider, siteId, accountBindingId, environment } = exactRecord(
    context,
    ["provider", "siteId", "accountBindingId", "environment"],
  );
  if (
    provider !== "ASAAS" ||
    !validId(siteId) ||
    !validId(accountBindingId) ||
    (environment !== "sandbox" && environment !== "live")
  ) {
    return unavailable();
  }
  return { provider, siteId, accountBindingId, environment };
}

function readKey(keyring: ProviderCredentialKeyring, keyId: string): Buffer {
  if (!validId(keyId)) return unavailable();
  const key = keyring.get(keyId);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    return unavailable();
  }
  return Buffer.from(key);
}

function validateSecretText(credential: string) {
  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    credential.length > MAX_SECRET_BYTES ||
    credential.trim().length === 0
  ) {
    return unavailable();
  }
}

function decodeBase64url(value: unknown, minBytes: number, maxBytes: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return unavailable();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minBytes ||
    decoded.length > maxBytes ||
    decoded.toString("base64url") !== value
  ) {
    return unavailable();
  }
  return decoded;
}

function readEnvelope(envelope: unknown) {
  const { version, keyId, nonce, ciphertext, tag } = exactRecord(envelope, [
    "version",
    "keyId",
    "nonce",
    "ciphertext",
    "tag",
  ]);
  if (version !== 1 || !validId(keyId)) return unavailable();
  return {
    version,
    keyId,
    nonce: decodeBase64url(nonce, 12, 12),
    ciphertext: decodeBase64url(ciphertext, 1, MAX_SECRET_BYTES),
    tag: decodeBase64url(tag, 16, 16),
  };
}

function additionalData(
  version: number,
  keyId: string,
  context: ProviderCredentialContext,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "entrelacos.provider-credential",
      version,
      keyId,
      context.provider,
      context.siteId,
      context.accountBindingId,
      context.environment,
    ]),
    "utf8",
  );
}

function encryptWithNonce(
  credential: string,
  context: ProviderCredentialContext,
  keyring: ProviderCredentialKeyring,
  keyId: string,
  nonceSource: () => Uint8Array,
): ProviderCredentialEnvelope {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const binding = readContext(context);
    validateSecretText(credential);
    key = readKey(keyring, keyId);
    plaintext = Buffer.from(credential, "utf8");
    if (
      plaintext.length > MAX_SECRET_BYTES ||
      plaintext.toString("utf8") !== credential
    ) {
      return unavailable();
    }
    const generatedNonce = nonceSource();
    if (
      !(generatedNonce instanceof Uint8Array) ||
      generatedNonce.byteLength !== 12
    ) {
      return unavailable();
    }
    const nonce = Buffer.from(generatedNonce);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(additionalData(1, keyId, binding));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Object.freeze({
      version: 1,
      keyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  } catch {
    throw new ProviderCredentialServiceError();
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}

export function encryptProviderCredential(
  credential: string,
  context: ProviderCredentialContext,
  keyring: ProviderCredentialKeyring,
  keyId: string,
): ProviderCredentialEnvelope {
  return encryptWithNonce(credential, context, keyring, keyId, () =>
    randomBytes(12),
  );
}

export function decryptProviderCredential(
  envelope: unknown,
  context: ProviderCredentialContext,
  keyring: ProviderCredentialKeyring,
): string {
  let key: Buffer | undefined;
  let decoded: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const binding = readContext(context);
    const value = readEnvelope(envelope);
    key = readKey(keyring, value.keyId);
    const decipher = createDecipheriv("aes-256-gcm", key, value.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(additionalData(value.version, value.keyId, binding));
    decipher.setAuthTag(value.tag);
    decoded = decipher.update(value.ciphertext);
    plaintext = Buffer.concat([decoded, decipher.final()]);
    const credential = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(plaintext);
    validateSecretText(credential);
    return credential;
  } catch {
    throw new ProviderCredentialServiceError();
  } finally {
    key?.fill(0);
    decoded?.fill(0);
    plaintext?.fill(0);
  }
}

// Deterministic nonces are only for isolated tests, never persisted credentials.
export function createProviderCredentialCryptoForTests(
  nonceSource: () => Uint8Array,
) {
  return {
    encryptProviderCredential(
      credential: string,
      context: ProviderCredentialContext,
      keyring: ProviderCredentialKeyring,
      keyId: string,
    ) {
      return encryptWithNonce(credential, context, keyring, keyId, nonceSource);
    },
    decryptProviderCredential,
  };
}
