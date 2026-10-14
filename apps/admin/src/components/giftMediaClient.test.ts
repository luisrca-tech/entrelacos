import { createHash } from "node:crypto";
import type { GiftItem, MeResponse } from "@entrelacos/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { createGiftMediaController } from "./giftMediaClient";
import { createPanelActorOwner } from "./panelActor";

const instant = Date.parse("2026-10-13T07:00:00Z");
const gift: GiftItem = {
  id: "gift-a",
  siteId: "site-a",
  title: "Jantar",
  description: "",
  nominalCents: 10000,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  sortOrder: 0,
  publicationState: "DRAFT",
  createdAt: new Date(instant).toISOString(),
  updatedAt: new Date(instant).toISOString(),
};
const actor: MeResponse = {
  user: {
    id: "assistant-a",
    name: "Ana",
    email: "ana@example.test",
    role: "SITE_ASSISTANT",
  },
  session: {
    id: "session-a",
    expiresAt: new Date(instant + 3600000).toISOString(),
  },
  siteId: "site-a",
  memberships: [
    {
      siteId: "site-a",
      userId: "assistant-a",
      membershipId: "membership-a",
      membershipRole: "SITE_ASSISTANT",
      capabilities: {
        manageCatalog: true,
        manageInvitations: true,
        manageMessages: true,
        manageTeam: false,
        configureReceiving: false,
        readFinance: false,
        requestWithdrawal: false,
      },
    },
  ],
};
const upload = {
  id: "asset-a",
  expiresAt: new Date(instant + 300000).toISOString(),
};
const media = {
  id: "asset-a",
  siteId: "site-a",
  url: "https://media.example.test/gifts/site-a/asset-a/original.webp",
  contentType: "image/webp" as const,
  byteLength: 2,
  width: 2,
  height: 2,
};
const unknown = {
  siteId: "site-a",
  assetId: "asset-a",
  state: "UNKNOWN" as const,
  expiresAt: upload.expiresAt,
  canRetrySameBytes: false,
  media: null,
};
const file = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(instant);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden");
    }),
  );
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  const owner = createPanelActorOwner({
    request: async () => actor,
    now: () => instant,
  });
  await owner.load();
  cleanup.push(() => owner.dispose());
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  const request = vi.fn().mockResolvedValue({ upload });
  const transport = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ media }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  const changed = vi.fn();
  const invalidated = vi.fn();
  const ports = {
    owner,
    storage,
    request,
    transport,
    now: () => Date.now(),
    isCurrent: () => true,
    onEligibilityChanged: invalidated,
  };
  const controller = createGiftMediaController(gift, changed, ports);
  cleanup.push(() => controller.dispose());
  return {
    controller,
    owner,
    values,
    storage,
    request,
    transport,
    changed,
    invalidated,
    ports,
  };
}
describe("inline gift media client ownership and retained correlation", () => {
  it("does not even capture a failure reporter after its eligibility callback loses ownership", async () => {
    const f = await fixture();
    const report = f.owner.reportFailure;
    const capture = vi.fn(() => report);
    Object.defineProperty(f.owner, "reportFailure", { get: capture });
    f.invalidated.mockImplementation(() => f.controller.dispose());
    f.request.mockRejectedValueOnce(new ApiError(403, "MEMBERSHIP_DENIED"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.invalidated).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(["snapshot", "scope"])(
    "rejects disposal inside its final %s callback",
    async (boundary) => {
      const f = await fixture();
      let reads = 0;
      if (boundary === "snapshot") {
        const snapshot = f.owner.getSnapshot();
        vi.spyOn(f.owner, "getSnapshot").mockImplementation(() => {
          if (++reads === 2) f.controller.dispose();
          return snapshot;
        });
      } else
        f.ports.isCurrent = () => {
          if (++reads === 2) f.controller.dispose();
          return true;
        };
      expect(f.controller.current()).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("does not report an old failure when capturing the owner callback disposes its controller", async () => {
    const f = await fixture();
    const report = vi.fn();
    Object.defineProperty(f.owner, "reportFailure", {
      get() {
        f.controller.dispose();
        return report;
      },
    });
    f.request.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
  it("compares the exact retained marker again after upload notifications before binary dispatch", async () => {
    const f = await fixture();
    let replacement = "";
    f.changed.mockImplementation((state) => {
      if (state.state === "UPLOADING") {
        const [key, value] = [...f.values][0];
        replacement = JSON.stringify({
          ...JSON.parse(value),
          assetId: "other-asset",
        });
        f.values.set(key, replacement);
      }
    });
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect([...f.values.values()]).toEqual([replacement]);
  });
  it("masks finalized projection immediately when its actual owner is replaced", async () => {
    const f = await fixture();
    await f.controller.upload(file());
    f.owner.invalidate(false);
    expect(f.controller.getState()).toMatchObject({ media: null, busy: false });
    expect(f.values.size).toBe(1);
  });
  it("invalidates receiving eligibility on a native structured denial without losing correlation", async () => {
    const f = await fixture();
    f.transport.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "RECEIVING_NOT_READY" }), {
        status: 409,
      }),
    );
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.invalidated).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(1);
  });
  it("reports an actual native401 to the same immutable session owner", async () => {
    const f = await fixture();
    f.request.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.owner.getSnapshot().status).toBe("unauthenticated");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["storage", "clock"])(
    "rejects replacement of the captured %s port before hashing or lease dispatch",
    async (port) => {
      const f = await fixture();
      if (port === "storage") f.ports.storage = { ...f.storage };
      else f.ports.now = () => instant - 1;
      await expect(f.controller.upload(file())).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it("does not dispatch if the original lease expires during correlation persistence", async () => {
    const f = await fixture();
    const write = f.storage.setItem.getMockImplementation();
    if (!write) throw new Error("Missing fixture implementation");
    f.storage.setItem.mockImplementationOnce((key, value) => {
      write(key, value);
      vi.setSystemTime(instant + 300001);
    });
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.values.size).toBe(1);
  });
  it("retains uncertainty when correlation persistence writes but loses its acknowledgement", async () => {
    const f = await fixture();
    const write = f.storage.setItem.getMockImplementation();
    if (!write) throw new Error("Missing fixture implementation");
    f.storage.setItem.mockImplementationOnce((key, value) => {
      write(key, value);
      throw new Error("Lost acknowledgement");
    });
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.controller.getState()).toMatchObject({
      state: "UNKNOWN",
      retained: true,
    });
    expect(f.values.size).toBe(1);
  });
  it.each([
    "invalid JSON",
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      siteId: "site-a",
      operatorId: "assistant-a",
      giftId: "gift-a",
      assetId: "asset-a",
      contentSha256: "private",
    }),
  ])("fails closed on a corrupt or legacy retained marker", async (value) => {
    const f = await fixture();
    f.controller.dispose();
    f.values.set("entrelacos-gift-media-v1:site-a:assistant-a:gift-a", value);
    const second = createGiftMediaController(gift, f.changed, f.ports);
    cleanup.push(() => second.dispose());
    await second.start();
    await expect(second.upload(file())).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect([...f.values.values()]).toEqual([value]);
  });
  it.each([
    { ...upload, expiresAt: new Date(instant - 1).toISOString() },
    { ...upload, putUrl: "https://private.example.test" },
  ])(
    "rejects expired or private lease output without binary dispatch",
    async (value) => {
      const f = await fixture();
      f.request.mockResolvedValueOnce({ upload: value });
      await expect(f.controller.upload(file())).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it("hashes bounded bytes, persists only correlation before same-origin binary transport and retains until confirmed attachment", async () => {
    const f = await fixture();
    f.transport.mockImplementationOnce(async (path, init) => {
      expect(path).toBe("/api/v1/sites/site-a/gift-media/asset-a/finalize");
      expect(init).toMatchObject({
        method: "POST",
        body: expect.any(Blob),
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
      expect(Object.fromEntries(new Headers(init.headers))).toEqual({
        "content-type": "image/png",
      });
      expect([...f.values.values()].map((value) => JSON.parse(value))).toEqual([
        {
          version: 1,
          siteId: "site-a",
          operatorId: "assistant-a",
          giftId: "gift-a",
          assetId: "asset-a",
        },
      ]);
      return new Response(JSON.stringify({ media }));
    });
    await expect(f.controller.upload(file())).resolves.toEqual(media);
    expect(f.request).toHaveBeenCalledWith(
      "/v1/sites/site-a/gift-media/uploads",
      expect.objectContaining({
        method: "POST",
        body: {
          contentType: "image/png",
          byteLength: 3,
          contentSha256: createHash("sha256")
            .update(new Uint8Array([1, 2, 3]))
            .digest("hex"),
        },
      }),
    );
    expect(f.values.size).toBe(1);
    f.controller.confirmCatalog([{ ...gift, mediaAssetId: "asset-b" }]);
    expect(f.values.size).toBe(1);
    f.controller.confirmCatalog([
      { ...gift, mediaAssetId: media.id, altText: "Mesa" },
    ]);
    expect(f.values.size).toBe(0);
  });
  it.each(["unsupported", "empty", "oversized"])(
    "denies %s bytes before requesting any lease",
    async (kind) => {
      const f = await fixture();
      const selected =
        kind === "unsupported"
          ? new Blob(["svg"], { type: "image/svg+xml" })
          : new Blob([new Uint8Array(kind === "empty" ? 0 : 5242881)], {
              type: "image/png",
            });
      await expect(f.controller.upload(selected)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it("reserves the attempt synchronously and does not issue a second lease", async () => {
    const f = await fixture();
    const pending = deferred<Response>();
    const entered = deferred<void>();
    f.transport.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const first = f.controller.upload(file());
    await entered.promise;
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
    pending.resolve(new Response(JSON.stringify({ media })));
    await first;
  });
  it("retains ambiguous transport and reload performs only consultation", async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error("private diagnostic"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.controller.getState()).toMatchObject({
      state: "UNKNOWN",
      retained: true,
    });
    f.controller.dispose();
    f.request.mockClear().mockResolvedValue({ status: unknown });
    f.transport.mockClear();
    const second = createGiftMediaController(gift, f.changed, f.ports);
    cleanup.push(() => second.dispose());
    await second.start();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith(
      "/v1/sites/site-a/gift-media/asset-a/finalize",
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.values.size).toBe(1);
  });
  it("recovery is explicit and never uploads or creates another lease", async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    f.request
      .mockClear()
      .mockResolvedValue({ status: { ...unknown, state: "FINALIZED", media } });
    f.transport.mockClear();
    await expect(f.controller.recover()).resolves.toEqual(media);
    expect(f.request).toHaveBeenCalledWith(
      "/v1/sites/site-a/gift-media/asset-a/finalize",
      expect.objectContaining({ method: "POST", body: { action: "RECOVER" } }),
    );
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.values.size).toBe(1);
  });
  it("permits only explicit byte reselection on an authoritative same-byte retry and keeps the original asset", async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    f.request
      .mockClear()
      .mockResolvedValue({ status: { ...unknown, canRetrySameBytes: true } });
    await f.controller.consult();
    f.request.mockClear();
    f.transport.mockClear();
    await expect(f.controller.upload(file())).resolves.toEqual(media);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport.mock.calls[0][0]).toContain("/asset-a/finalize");
  });
  it("never replaces a retained unknown after expired time,404 or unavailable consultation", async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    const marker = [...f.values.values()][0];
    f.request.mockClear().mockRejectedValue(new ApiError(404, "NOT_FOUND"));
    await expect(f.controller.consult()).rejects.toThrow();
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
    expect([...f.values.values()]).toEqual([marker]);
  });
  it("clears only a correlated authoritative closed result after current catalog inspection", async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(f.controller.upload(file())).rejects.toThrow();
    f.request.mockResolvedValueOnce({
      status: { ...unknown, state: "FAILED" },
    });
    await f.controller.consult();
    expect(f.values.size).toBe(1);
    f.controller.confirmCatalog([{ ...gift, id: "other-gift" }]);
    expect(f.values.size).toBe(1);
    f.controller.confirmCatalog([gift]);
    expect(f.values.size).toBe(0);
  });
  it("does not clear a marker replaced by another tab", async () => {
    const f = await fixture();
    await f.controller.upload(file());
    const [key, value] = [...f.values][0];
    const replacement = JSON.stringify({
      ...JSON.parse(value),
      assetId: "other-asset",
    });
    f.values.set(key, replacement);
    f.controller.confirmCatalog([{ ...gift, mediaAssetId: media.id }]);
    expect(f.values.get(key)).toBe(replacement);
  });
  it("requires durable write acknowledgement before dispatch and does not expose transport diagnostics", async () => {
    const f = await fixture();
    f.storage.setItem.mockImplementationOnce(() => {
      throw new Error("private storage");
    });
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.controller.getState().error).not.toContain("private");
  });
  it("fences owner replacement while the actual file read is pending", async () => {
    const f = await fixture();
    const bytes = deferred<ArrayBuffer>();
    const entered = deferred<void>();
    const selected = file();
    vi.spyOn(selected, "arrayBuffer").mockImplementation(() => {
      entered.resolve();
      return bytes.promise;
    });
    const result = f.controller.upload(selected);
    await entered.promise;
    f.owner.invalidate(false);
    const observed = f.changed.mock.calls.length;
    bytes.resolve(new Uint8Array([1, 2, 3]).buffer);
    await expect(result).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.changed.mock.calls).toHaveLength(observed);
  });
  it("aborts dispatched transport on owner loss and ignores its late finalized result without clearing correlation", async () => {
    const f = await fixture();
    const pending = deferred<Response>();
    const entered = deferred<void>();
    let signal!: AbortSignal;
    f.transport.mockImplementationOnce((_path, init) => {
      signal = init.signal;
      entered.resolve();
      return pending.promise;
    });
    const result = f.controller.upload(file());
    await entered.promise;
    f.owner.invalidate(false);
    expect(signal.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({ media })));
    await expect(result).rejects.toThrow();
    expect(f.values.size).toBe(1);
  });
  it("rejects private and cross-scope positive binary responses while retaining the original correlation", async () => {
    const f = await fixture();
    f.transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          media: { ...media, siteId: "foreign", privateKey: "private" },
        }),
      ),
    );
    await expect(f.controller.upload(file())).rejects.toThrow();
    expect(f.controller.getState()).toMatchObject({
      state: "UNKNOWN",
      retained: true,
    });
    expect(f.values.size).toBe(1);
  });
});
