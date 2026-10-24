import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderCredentialCryptoForTests,
  decryptProviderCredential,
  encryptProviderCredential,
  type ProviderCredentialContext,
  ProviderCredentialServiceError,
} from "./providerCredentials";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn() };
});

afterEach(() => vi.restoreAllMocks());

const credential = "test-only-provider-api-token";
const nonce = Buffer.alloc(12, 7);

function fixture() {
  const key = Buffer.alloc(32, 19);
  const keyring = new Map([["encryption-key-v1", key]]);
  const context: ProviderCredentialContext = {
    provider: "ASAAS",
    siteId: "site-one",
    accountBindingId: "receiving-account-one",
    environment: "sandbox",
  };
  const crypto = createProviderCredentialCryptoForTests(() => nonce);
  return { key, keyring, context, crypto };
}

function expectedAdditionalData(
  context: ProviderCredentialContext,
  version = 1,
  keyId = "encryption-key-v1",
) {
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
  );
}

function authenticatedFixture(
  plaintext: Buffer,
  values: ReturnType<typeof fixture>,
  version = 1,
  fixtureNonce = nonce,
) {
  const cipher = createCipheriv("aes-256-gcm", values.key, fixtureNonce, {
    authTagLength: 16,
  });
  cipher.setAAD(expectedAdditionalData(values.context, version));
  return {
    version,
    keyId: "encryption-key-v1",
    nonce: fixtureNonce.toString("base64url"),
    ciphertext: Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]).toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function sealed(values: ReturnType<typeof fixture>) {
  return values.crypto.encryptProviderCredential(
    credential,
    values.context,
    values.keyring,
    "encryption-key-v1",
  );
}

function expectUnavailable(operation: () => unknown) {
  expect(operation).toThrow(ProviderCredentialServiceError);
  expect(operation).toThrow(
    expect.objectContaining({
      status: 503,
      code: "PROVIDER_CREDENTIAL_UNAVAILABLE",
      message: "Provider credential is unavailable",
    }),
  );
}

function changeByte(encoded: string) {
  const bytes = Buffer.from(encoded, "base64url");
  bytes[0] ^= 1;
  return bytes.toString("base64url");
}

describe("server-bound provider credential encryption", () => {
  it("round-trips a credential through an authenticated versioned envelope", () => {
    const { keyring, context, crypto } = fixture();
    const envelope = crypto.encryptProviderCredential(
      credential,
      context,
      keyring,
      "encryption-key-v1",
    );
    expect(envelope).toEqual({
      version: 1,
      keyId: "encryption-key-v1",
      nonce: nonce.toString("base64url"),
      ciphertext: expect.any(String),
      tag: expect.any(String),
    });
    expect(Buffer.from(envelope.ciphertext, "base64url")).toHaveLength(
      Buffer.byteLength(credential),
    );
    expect(Buffer.from(envelope.tag, "base64url")).toHaveLength(16);
    expect(decryptProviderCredential(envelope, context, keyring)).toBe(
      credential,
    );
    expect(JSON.stringify(envelope)).not.toContain(credential);
  });

  it("produces an envelope decryptable with independent Node GCM and canonical AAD", () => {
    const values = fixture();
    const envelope = sealed(values);
    const decipher = createDecipheriv("aes-256-gcm", values.key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(expectedAdditionalData(values.context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    expect(plaintext.toString("utf8")).toBe(credential);
  });

  it("uses the production randomBytes source for independent 12-byte nonces", () => {
    const values = fixture();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.alloc(12, 3) as never)
      .mockReturnValueOnce(Buffer.alloc(12, 4) as never);
    const first = encryptProviderCredential(
      credential,
      values.context,
      values.keyring,
      "encryption-key-v1",
    );
    const second = encryptProviderCredential(
      credential,
      values.context,
      values.keyring,
      "encryption-key-v1",
    );
    expect(randomBytes).toHaveBeenNthCalledWith(1, 12);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 12);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.tag).not.toBe(second.tag);
    expect(
      decryptProviderCredential(first, values.context, values.keyring),
    ).toBe(credential);
    expect(
      decryptProviderCredential(second, values.context, values.keyring),
    ).toBe(credential);
  });

  it.each(["ciphertext", "tag", "nonce"] as const)(
    "refuses tampered %s without releasing plaintext",
    (field) => {
      const values = fixture();
      const envelope = sealed(values);
      const altered = { ...envelope, [field]: changeByte(envelope[field]) };
      expectUnavailable(() =>
        decryptProviderCredential(altered, values.context, values.keyring),
      );
    },
  );

  it.each([
    { provider: "OTHER" },
    { siteId: "site-two" },
    { accountBindingId: "receiving-account-two" },
    { environment: "live" },
  ])("refuses a different server context %o", (override) => {
    const values = fixture();
    const context = { ...values.context, ...override };
    expectUnavailable(() =>
      decryptProviderCredential(
        sealed(values),
        context as ProviderCredentialContext,
        values.keyring,
      ),
    );
  });

  it("canonicalizes property order and keeps delimiter-shaped IDs distinct", () => {
    const values = fixture();
    values.context.siteId = "site:one";
    values.context.accountBindingId = "account";
    const envelope = sealed(values);
    expect(
      decryptProviderCredential(
        envelope,
        {
          environment: "sandbox",
          accountBindingId: "account",
          siteId: "site:one",
          provider: "ASAAS",
        },
        values.keyring,
      ),
    ).toBe(credential);
    expectUnavailable(() =>
      decryptProviderCredential(
        envelope,
        { ...values.context, siteId: "site", accountBindingId: "one:account" },
        values.keyring,
      ),
    );
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing site", { siteId: undefined }],
    ["empty site", { siteId: "" }],
    ["whitespace site", { siteId: " site-one" }],
    ["long site", { siteId: "x".repeat(129) }],
    ["invalid site", { siteId: "site|one" }],
    ["newline site", { siteId: "site-one\n" }],
    ["carriage return account", { accountBindingId: "account-one\r" }],
    ["Unicode line ending account", { accountBindingId: "account-one\u2028" }],
    ["empty account binding", { accountBindingId: "" }],
    ["wrong provider", { provider: "asaas" }],
    ["wrong environment", { environment: "production" }],
    ["unknown fields", { walletId: "request-selected-wallet" }],
  ])("rejects malformed encryption context: %s", (_, override) => {
    const values = fixture();
    const context =
      override === null || Array.isArray(override)
        ? override
        : { ...values.context, ...override };
    expectUnavailable(() =>
      values.crypto.encryptProviderCredential(
        credential,
        context as ProviderCredentialContext,
        values.keyring,
        "encryption-key-v1",
      ),
    );
  });

  it("rejects unknown fields even if decryption context otherwise authenticates", () => {
    const values = fixture();
    expectUnavailable(() =>
      decryptProviderCredential(
        sealed(values),
        Object.assign({ ...values.context }, { ready: true }),
        values.keyring,
      ),
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \t\n"],
    ["too many bytes", "a".repeat(8193)],
    ["too many Unicode bytes", "é".repeat(4097)],
    ["unpaired Unicode surrogate", "secret\ud800"],
    ["null", null],
    ["number", 7],
    ["object", {}],
  ])("rejects invalid secret text: %s", (_, plaintext) => {
    const values = fixture();
    expectUnavailable(() =>
      values.crypto.encryptProviderCredential(
        plaintext as string,
        values.context,
        values.keyring,
        "encryption-key-v1",
      ),
    );
  });

  it.each([" a secret with spaces ", "é".repeat(4096)])(
    "preserves valid UTF-8 secret bytes without trimming",
    (plaintext) => {
      const values = fixture();
      const envelope = values.crypto.encryptProviderCredential(
        plaintext,
        values.context,
        values.keyring,
        "encryption-key-v1",
      );
      expect(
        decryptProviderCredential(envelope, values.context, values.keyring),
      ).toBe(plaintext);
    },
  );

  it.each([
    ["missing", undefined],
    ["31 bytes", Buffer.alloc(31)],
    ["33 bytes", Buffer.alloc(33)],
    ["string", "k".repeat(32)],
    ["plain array", new Array(32).fill(19)],
  ])("rejects %s key material for both operations", (_, injected) => {
    const values = fixture();
    const envelope = sealed(values);
    const keyring = new Map([["encryption-key-v1", injected]]);
    expectUnavailable(() =>
      values.crypto.encryptProviderCredential(
        credential,
        values.context,
        keyring as typeof values.keyring,
        "encryption-key-v1",
      ),
    );
    expectUnavailable(() =>
      decryptProviderCredential(
        envelope,
        values.context,
        keyring as typeof values.keyring,
      ),
    );
  });

  it.each(["", " key-one", "key|one", "k".repeat(129), "key-one\n"])(
    "refuses invalid selected key IDs",
    (keyId) => {
      const values = fixture();
      values.keyring.set(keyId, values.key);
      expectUnavailable(() =>
        values.crypto.encryptProviderCredential(
          credential,
          values.context,
          values.keyring,
          keyId,
        ),
      );
    },
  );

  it("fails closed for missing selected keys without falling back", () => {
    const values = fixture();
    expectUnavailable(() =>
      values.crypto.encryptProviderCredential(
        credential,
        values.context,
        values.keyring,
        "unknown-key",
      ),
    );
    const envelope = sealed(values);
    values.keyring.delete("encryption-key-v1");
    values.keyring.set("another-key", values.key);
    expectUnavailable(() =>
      decryptProviderCredential(envelope, values.context, values.keyring),
    );
  });

  it("decrypts old and new envelopes only through their recorded key IDs", () => {
    const values = fixture();
    const oldEnvelope = sealed(values);
    values.keyring.set("encryption-key-v2", Buffer.alloc(32, 29));
    const newEnvelope = values.crypto.encryptProviderCredential(
      credential,
      values.context,
      values.keyring,
      "encryption-key-v2",
    );
    for (const envelope of [oldEnvelope, newEnvelope]) {
      expect(
        decryptProviderCredential(envelope, values.context, values.keyring),
      ).toBe(credential);
    }
    values.keyring.delete("encryption-key-v1");
    expectUnavailable(() =>
      decryptProviderCredential(oldEnvelope, values.context, values.keyring),
    );
    expect(
      decryptProviderCredential(newEnvelope, values.context, values.keyring),
    ).toBe(credential);
  });

  it("authenticates the key ID even when another ID contains identical key bytes", () => {
    const values = fixture();
    const envelope = sealed(values);
    values.keyring.set("encryption-key-alias", values.key);
    expectUnavailable(() =>
      decryptProviderCredential(
        { ...envelope, keyId: "encryption-key-alias" },
        values.context,
        values.keyring,
      ),
    );
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["extra plaintext", { plaintext: credential }],
    ["wrong version type", { version: "1" }],
    ["unknown version", { version: 2 }],
    ["invalid key ID", { keyId: "invalid key" }],
    ["missing nonce", { nonce: undefined }],
    ["empty ciphertext", { ciphertext: "" }],
    ["oversized ciphertext", { ciphertext: "A".repeat(10924) }],
    ["nonstring ciphertext", { ciphertext: 7 }],
    ["nonstring tag", { tag: Buffer.alloc(16) }],
  ])("rejects malformed envelope: %s", (_, override) => {
    const values = fixture();
    const envelope =
      override === null || Array.isArray(override)
        ? override
        : Object.keys(override).length === 0
          ? override
          : { ...sealed(values), ...override };
    expectUnavailable(() =>
      decryptProviderCredential(envelope, values.context, values.keyring),
    );
  });

  it.each(["nonce", "ciphertext", "tag"] as const)(
    "rejects noncanonical base64url in %s",
    (field) => {
      const values = fixture();
      const envelope = sealed(values);
      for (const suffix of ["=", "\n", " "]) {
        expectUnavailable(() =>
          decryptProviderCredential(
            { ...envelope, [field]: envelope[field] + suffix },
            values.context,
            values.keyring,
          ),
        );
      }
    },
  );

  it("rejects noncanonical trailing bits even when decoded tag bytes are unchanged", () => {
    const values = fixture();
    const envelope = sealed(values);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(envelope.tag.at(-1) ?? "");
    const noncanonicalTag = envelope.tag.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(noncanonicalTag, "base64url")).toEqual(
      Buffer.from(envelope.tag, "base64url"),
    );
    expectUnavailable(() =>
      decryptProviderCredential(
        { ...envelope, tag: noncanonicalTag },
        values.context,
        values.keyring,
      ),
    );
  });

  it("rejects a cryptographically authenticated unsupported envelope version", () => {
    const values = fixture();
    expectUnavailable(() =>
      decryptProviderCredential(
        authenticatedFixture(Buffer.from(credential), values, 2),
        values.context,
        values.keyring,
      ),
    );
  });

  it.each([11, 13])("rejects authenticated %i-byte nonces", (length) => {
    const values = fixture();
    const envelope = authenticatedFixture(
      Buffer.from(credential),
      values,
      1,
      Buffer.alloc(length, 7),
    );
    expectUnavailable(() =>
      decryptProviderCredential(envelope, values.context, values.keyring),
    );
    const crypto = createProviderCredentialCryptoForTests(() =>
      Buffer.alloc(length, 7),
    );
    expectUnavailable(() =>
      crypto.encryptProviderCredential(
        credential,
        values.context,
        values.keyring,
        "encryption-key-v1",
      ),
    );
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["whitespace", Buffer.from("   ")],
    ["too large", Buffer.alloc(8193, 65)],
    ["invalid UTF-8", Buffer.from([0xff])],
  ])("rejects authenticated invalid plaintext: %s", (_, plaintext) => {
    const values = fixture();
    expectUnavailable(() =>
      decryptProviderCredential(
        authenticatedFixture(plaintext, values),
        values.context,
        values.keyring,
      ),
    );
  });

  it("preserves caller key/nonce buffers and copies keys before nonce callbacks", () => {
    const values = fixture();
    const originalKey = Buffer.from(values.key);
    const originalNonce = Buffer.from(nonce);
    const envelope = sealed(values);
    expect(values.key).toEqual(originalKey);
    expect(nonce).toEqual(originalNonce);
    decryptProviderCredential(envelope, values.context, values.keyring);
    expect(values.key).toEqual(originalKey);
    const crypto = createProviderCredentialCryptoForTests(() => {
      values.key.fill(29);
      return nonce;
    });
    const copiedKeyEnvelope = crypto.encryptProviderCredential(
      credential,
      values.context,
      values.keyring,
      "encryption-key-v1",
    );
    expect(
      decryptProviderCredential(
        copiedKeyEnvelope,
        values.context,
        new Map([["encryption-key-v1", originalKey]]),
      ),
    ).toBe(credential);
  });

  it("returns sanitized errors without secret values, causes, or logging", () => {
    const values = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(values.keyring, "get").mockImplementation(() => {
      throw new Error(`Raw crypto failure for ${credential}`);
    });
    try {
      values.crypto.encryptProviderCredential(
        credential,
        values.context,
        values.keyring,
        "encryption-key-v1",
      );
      throw new Error("Expected encryption failure");
    } catch (failure) {
      expect(failure).toBeInstanceOf(ProviderCredentialServiceError);
      expect(JSON.stringify(failure)).not.toContain(credential);
      expect((failure as Error).message).toBe(
        "Provider credential is unavailable",
      );
      expect((failure as Error).stack).not.toContain("Raw crypto failure");
      expect((failure as Error).cause).toBeUndefined();
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("uses copied context and envelope values despite keyring callback mutation", () => {
    const values = fixture();
    const context = { ...values.context };
    const envelope = { ...sealed(values) };
    vi.spyOn(values.keyring, "get").mockImplementation(() => {
      context.siteId = "replacement-site";
      envelope.keyId = "replacement-key";
      envelope.tag = "malformed";
      return values.key;
    });
    expect(decryptProviderCredential(envelope, context, values.keyring)).toBe(
      credential,
    );
  });
});
