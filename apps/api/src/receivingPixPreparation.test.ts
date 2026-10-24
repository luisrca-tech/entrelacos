import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { createReceivingPixPreparation } from "./receivingPixPreparation";

const binding = {
  provider: "ASAAS" as const,
  siteId: "site-one",
  accountBindingId: "account-one",
  accountReference: "child-account",
  recipientReference: "child-wallet",
  environment: "live" as const,
};
const actor = {
  siteId: binding.siteId,
  userId: "holder-one",
  sessionId: "session-one",
};
function fixture() {
  let claimed = false;
  let active = false;
  const status = {
    id: "status-one",
    commercialInfo: "APPROVED",
    bankAccountInfo: "PENDING",
    documentation: "APPROVED",
    general: "APPROVED",
  };
  const keys: { id: string; type: string; status: string }[] = [];
  const arm = vi.fn(async (): Promise<string | null> => {
    if (claimed) return null;
    claimed = true;
    return "attempt-one";
  });
  const settle = vi.fn(async (_attempt: string, _outcome: string) => {});
  const fetch = vi.fn(
    async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = new URL(String(url)).pathname;
      let body: unknown;
      if (path.endsWith("/wallets/"))
        body = { data: [{ id: "child-wallet" }], hasMore: false };
      else if (path.endsWith("/myAccount/status/")) body = status;
      else if (path.endsWith("/myAccount/commercialInfo/"))
        body = { commercialInfoExpiration: { isExpired: false } };
      else if (path.endsWith("/pix/addressKeys") && init?.method === "POST") {
        active = true;
        body = { id: "key-one", type: "EVP", status: "ACTIVE" };
      } else if (path.endsWith("/pix/addressKeys"))
        body = {
          hasMore: false,
          data: active
            ? [{ id: "key-one", type: "EVP", status: "ACTIVE" }]
            : keys,
        };
      else throw new Error("Unexpected provider route");
      return Response.json(body);
    },
  );
  const service = createReceivingPixPreparation({
    repository: { arm, settle },
    fetch,
    now: () => new Date("2026-10-24T20:00:00Z"),
  });
  const run = () => service.prepare(actor, binding, "child-private-key");
  const posts = () =>
    fetch.mock.calls.filter(([, init]) => init?.method === "POST");
  return { service, run, fetch, status, keys, arm, settle, posts };
}
describe("automatic incoming Pix preparation", () => {
  it("closes without dispatching a claim whose acknowledgement arrives after shutdown", async () => {
    const v = fixture();
    let release = (_value: string | null) => {};
    v.arm.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const work = v.run();
    await vi.waitFor(() => expect(v.arm).toHaveBeenCalledOnce());
    const closed = v.service.close();
    release("attempt-one");
    expect(await work).toBe("REVIEW_REQUIRED");
    await closed;
    expect(v.posts()).toHaveLength(0);
    expect(v.settle).toHaveBeenCalledWith("attempt-one", "UNKNOWN");
    await expect(v.run()).rejects.toThrow();
  });
  it("creates only an EVP key after approval, then confirms it with an authenticated read", async () => {
    const v = fixture();
    expect(await v.run()).toBe("READY");
    expect(v.arm).toHaveBeenCalledWith(actor, binding);
    expect(v.posts()).toHaveLength(1);
    const [url, init] = v.posts()[0];
    expect(url).toBe("https://api.asaas.com/v3/pix/addressKeys");
    expect(init).toMatchObject({
      redirect: "error",
      body: JSON.stringify({ type: "EVP" }),
    });
    expect(new Headers(init?.headers).get("access_token")).toBe(
      "child-private-key",
    );
    expect(v.settle).toHaveBeenCalledWith("attempt-one", "SUBMITTED");
    expect(v.fetch.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    expect(await v.run()).toBe("READY");
    expect(v.posts()).toHaveLength(1);
  });
  it("reuses an existing active key without creating, deleting or porting a key", async () => {
    const v = fixture();
    v.keys.push({ id: "existing", type: "EMAIL", status: "ACTIVE" });
    expect(await v.run()).toBe("READY");
    expect(v.arm).not.toHaveBeenCalled();
    expect(v.posts()).toHaveLength(0);
  });
  it.each(["commercialInfo", "documentation", "general"] as const)(
    "waits for %s approval without posting",
    async (field) => {
      const v = fixture();
      v.status[field] = "AWAITING_APPROVAL";
      expect(await v.run()).toBe("PENDING");
      expect(v.arm).not.toHaveBeenCalled();
      expect(v.posts()).toHaveLength(0);
    },
  );
  it.each([
    "AWAITING_ACTIVATION",
    "AWAITING_DELETION",
    "AWAITING_ACCOUNT_DELETION",
    "ERROR",
  ])(
    "does not create another key while an existing key is %s",
    async (status) => {
      const v = fixture();
      v.keys.push({ id: "existing", type: "EVP", status });
      expect(await v.run()).toBe("PENDING");
      expect(v.arm).not.toHaveBeenCalled();
    },
  );
  it("does not post without a durable dispatch claim", async () => {
    const v = fixture();
    v.arm.mockResolvedValue(null);
    expect(await v.run()).toBe("REVIEW_REQUIRED");
    expect(v.posts()).toHaveLength(0);
  });
  it("never repeats an uncertain creation after a lost response, and reconciles by GET", async () => {
    const v = fixture();
    const original = v.fetch.getMockImplementation();
    assert(original);
    v.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("private provider detail");
      return original(url, init);
    });
    expect(await v.run()).toBe("REVIEW_REQUIRED");
    expect(await v.run()).toBe("REVIEW_REQUIRED");
    expect(v.posts()).toHaveLength(1);
    expect(v.settle).toHaveBeenCalledWith("attempt-one", "UNKNOWN");
    v.keys.push({ id: "reconciled", type: "EVP", status: "ACTIVE" });
    expect(await v.run()).toBe("READY");
    expect(v.posts()).toHaveLength(1);
  });
  it("allows only one dispatch across concurrent preparations", async () => {
    const v = fixture();
    await Promise.all([v.run(), v.run()]);
    expect(v.posts()).toHaveLength(1);
  });
  it("records a documented, well-formed rejection separately from an uncertain response", async () => {
    const v = fixture();
    const original = v.fetch.getMockImplementation();
    assert(original);
    v.fetch.mockImplementation(async (url, init) =>
      init?.method === "POST"
        ? Response.json(
            {
              errors: [
                {
                  code: "invalid_action",
                  description: "Private profile detail",
                },
              ],
            },
            { status: 400 },
          )
        : original(url, init),
    );
    expect(await v.run()).toBe("PENDING");
    expect(v.settle).toHaveBeenCalledWith("attempt-one", "REJECTED");
  });
  it.each([200, 400, 500])(
    "treats a malformed %i creation response as uncertain",
    async (status) => {
      const v = fixture();
      const original = v.fetch.getMockImplementation();
      assert(original);
      v.fetch.mockImplementation(async (url, init) =>
        init?.method === "POST"
          ? new Response("not-json", { status })
          : original(url, init),
      );
      expect(await v.run()).toBe("REVIEW_REQUIRED");
      expect(v.settle).toHaveBeenCalledWith("attempt-one", "UNKNOWN");
    },
  );
  it("rejects a foreign wallet before arming or posting", async () => {
    const v = fixture();
    const original = v.fetch.getMockImplementation();
    assert(original);
    v.fetch.mockImplementation(async (url, init) =>
      String(url).includes("/wallets/")
        ? Response.json({ data: [{ id: "foreign-wallet" }], hasMore: false })
        : original(url, init),
    );
    await expect(v.run()).rejects.toThrow(
      "Receiving setup provider unavailable",
    );
    expect(v.arm).not.toHaveBeenCalled();
    expect(v.posts()).toHaveLength(0);
  });
  it("rejects a foreign actor before any provider call", async () => {
    const v = fixture();
    await expect(
      v.service.prepare(
        { ...actor, siteId: "foreign" },
        binding,
        "child-private-key",
      ),
    ).rejects.toThrow();
    expect(v.fetch).not.toHaveBeenCalled();
  });
});
