import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAsaasAccountProvisioningClient,
  readAccountProvisioningInput,
} from "./asaasAccountProvisioningClient";
import { decryptProviderCredential } from "./providerCredentials";

const nonceState = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, ++nonceState.value),
}));
beforeEach(() => {
  nonceState.value = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const input = {
    name: "Fictional Operator",
    email: "fictional@example.test",
    cpfCnpj: "12345678909",
    mobilePhone: "11999999999",
    incomeValue: 1000,
    address: "Fictional Street",
    addressNumber: "1",
    province: "Fictional District",
    postalCode: "12345678",
    birthDate: "1990-01-01",
  };
  const keys = new Map([["credential-v1", new Uint8Array(32).fill(21)]]);
  const context = {
    provider: "ASAAS" as const,
    siteId: "site-one",
    accountBindingId: "account-one",
    environment: "sandbox" as const,
  };
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          child: "fictional-child",
          wallet: "fictional-wallet",
          key: "fictional-child-key",
        }),
        { status: 201 },
      ),
  );
  const normalizeOriginalResult = vi.fn(async (value: unknown) => {
    const body = value as { child: string; wallet: string; key: string };
    return {
      accountReference: body.child,
      recipientReference: body.wallet,
      credential: body.key,
    };
  });
  const options = {
    environment: "sandbox" as const,
    parentAccountReference: "fictional-parent",
    parentCredential: "fictional-parent-key",
    credentialContext: context,
    credentialKeys: keys,
    activeCredentialKeyId: "credential-v1",
    normalizeOriginalResult,
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
  return { input, keys, context, fetch, normalizeOriginalResult, options };
}
describe("private parent account provisioning adapter", () => {
  it("sanitizes unavailable configuration getters before reading private credentials", async () => {
    const values = fixture();
    Object.defineProperty(values.options, "normalizeOriginalResult", {
      get: () => {
        throw new Error("private configuration failure");
      },
    });
    let client:
      | ReturnType<typeof createAsaasAccountProvisioningClient>
      | undefined;
    expect(() => {
      client = createAsaasAccountProvisioningClient(values.options);
    }).not.toThrow();
    expect(client?.available).toBe(false);
    expect(values.fetch).not.toHaveBeenCalled();
    await client?.close();
  });
  it("captures each private parent credential setting exactly once", async () => {
    const values = fixture();
    const credential = vi.fn(() => "fictional-parent-key");
    Object.defineProperty(values.options, "parentCredential", {
      get: credential,
    });
    const client = createAsaasAccountProvisioningClient(values.options);
    await client.createOriginal(values.input);
    expect(credential).toHaveBeenCalledOnce();
    await client.close();
  });
  it("is unavailable without a verified native response normalizer and never uses implicit network", async () => {
    const values = fixture();
    const client = createAsaasAccountProvisioningClient({
      ...values.options,
      normalizeOriginalResult: undefined,
    });
    expect(client.available).toBe(false);
    await expect(client.createOriginal(values.input)).rejects.toThrow(
      "Account provisioning unavailable",
    );
    expect(values.fetch).not.toHaveBeenCalled();
    await client.close();
  });
  it("sends one fixed parent-authenticated request and returns only the original scoped envelope", async () => {
    const values = fixture();
    const client = createAsaasAccountProvisioningClient(values.options);
    const prepared = await client.createOriginal(values.input);
    expect(values.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api-sandbox.asaas.com/v3/accounts",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const request = values.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(request[1].headers).get("access_token")).toBe(
      "fictional-parent-key",
    );
    expect(JSON.parse(request[1].body as string)).toEqual(values.input);
    expect(
      decryptProviderCredential(
        prepared.credential,
        values.context,
        values.keys,
      ),
    ).toBe("fictional-child-key");
    expect(() =>
      decryptProviderCredential(
        prepared.credential,
        { ...values.context, accountBindingId: "other" },
        values.keys,
      ),
    ).toThrow();
    expect(JSON.stringify(prepared)).not.toMatch(
      /fictional-child-key|fictional-parent-key|cpfCnpj/,
    );
    await expect(client.createOriginal(values.input)).rejects.toThrow();
    expect(values.fetch).toHaveBeenCalledOnce();
    await client.close();
  });
  it.each(["unknown", "cpf", "date", "income", "control", "oversize"])(
    "invalid %s input cannot dispatch",
    async (change) => {
      const values = fixture();
      const input: Record<string, unknown> = { ...values.input };
      if (change === "unknown") input.externalReference = "invented";
      if (change === "cpf") input.cpfCnpj = "123.456.789-09";
      if (change === "date") input.birthDate = "1990-02-31";
      if (change === "income") input.incomeValue = 1.001;
      if (change === "control") input.name = "Name\u0000";
      if (change === "oversize") input.address = "x".repeat(257);
      const client = createAsaasAccountProvisioningClient(values.options);
      await expect(client.createOriginal(input as never)).rejects.toThrow();
      expect(values.fetch).not.toHaveBeenCalled();
      await client.close();
    },
  );
  it("normalizes the identical bounded input used for transport and identity", () => {
    const values = fixture();
    expect(
      readAccountProvisioningInput({ ...values.input, name: "  Cafe\u0301  " }),
    ).toEqual({ ...values.input, name: "Café" });
  });
  it("owns late response/body/normalizer work after cancellation and closes only after actual completion", async () => {
    const values = fixture();
    const response = deferred<Response>();
    const normalized = deferred<{
      accountReference: string;
      recipientReference: string;
      credential: string;
    }>();
    values.fetch.mockImplementation(() => response.promise);
    values.normalizeOriginalResult.mockImplementation(() => normalized.promise);
    const client = createAsaasAccountProvisioningClient(values.options);
    const abort = new AbortController();
    const operation = client.createOriginal(values.input, abort.signal);
    void operation.catch(() => {});
    abort.abort();
    const closing = client.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    response.resolve(new Response("{}", { status: 201 }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(closed).toBe(false);
    normalized.resolve({
      accountReference: "fictional-child",
      recipientReference: "fictional-wallet",
      credential: "fictional-child-key",
    });
    const result = await operation;
    await closing;
    expect(
      decryptProviderCredential(result.credential, values.context, values.keys),
    ).toBe("fictional-child-key");
    expect(closed).toBe(true);
    expect(values.fetch).toHaveBeenCalledOnce();
  });
  it.each(["status", "malformed", "missing-key", "body-limit"])(
    "possible dispatch %s has no provider retry and no private error",
    async (change) => {
      const values = fixture();
      values.fetch.mockResolvedValue(
        change === "status"
          ? new Response("private reply", { status: 500 })
          : new Response(
              change === "malformed"
                ? "private-invalid-json"
                : change === "body-limit"
                  ? "x".repeat(65537)
                  : JSON.stringify({
                      child: "fictional-child",
                      wallet: "fictional-wallet",
                    }),
              { status: 201 },
            ),
      );
      const client = createAsaasAccountProvisioningClient(values.options);
      await expect(client.createOriginal(values.input)).rejects.toThrow(
        "Account provisioning unavailable",
      );
      await expect(client.createOriginal(values.input)).rejects.toThrow();
      expect(values.fetch).toHaveBeenCalledOnce();
      await client.close();
    },
  );
});
