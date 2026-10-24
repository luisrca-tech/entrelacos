// @vitest-environment jsdom
import { Blob } from "node:buffer";
import { webcrypto } from "node:crypto";
import type { GiftItem, MeResponse } from "@entrelacos/contracts";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { createGiftEditorController, GiftEditor } from "./GiftEditor";
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
const media = {
  id: "asset-a",
  siteId: "site-a",
  url: "https://media.example.test/gifts/site-a/asset-a/original.webp",
  contentType: "image/webp",
  byteLength: 2,
  width: 2,
  height: 2,
};
const unknown = {
  siteId: "site-a",
  assetId: "asset-a",
  state: "UNKNOWN",
  expiresAt: new Date(instant + 300000).toISOString(),
  canRetrySameBytes: false,
  media: null,
};
const file = () =>
  new Blob([new Uint8Array([1, 2, 3])], {
    type: "image/png",
  }) as globalThis.Blob;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanup: (() => void)[] = [];
const mounted: Root[] = [];
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("crypto", webcrypto);
  vi.useFakeTimers();
  vi.setSystemTime(instant);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden");
    }),
  );
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
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
  let storedGift = { ...gift };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown; signal?: AbortSignal },
    ): Promise<unknown> => {
      if (path.endsWith("/gift-media/uploads"))
        return { upload: { id: "asset-a", expiresAt: unknown.expiresAt } };
      if (path.endsWith("/finalize")) return { status: unknown };
      if (options?.method === "PATCH") {
        storedGift = { ...storedGift, ...(options.body as object) };
        return { gift: storedGift };
      }
      return { gifts: [storedGift] };
    },
  );
  const transport = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ media })),
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
  };
  const controller = createGiftEditorController(
    "site-a",
    changed,
    ports,
    invalidated,
  );
  cleanup.push(() => controller.dispose());
  return {
    controller,
    owner,
    values,
    request,
    transport,
    changed,
    invalidated,
    ports,
    setGift: (value: GiftItem) => {
      storedGift = value;
    },
  };
}
describe("gift editor immutable scope and acknowledged attachment", () => {
  it("does not capture a session failure reporter after losing scope inside eligibility invalidation", async () => {
    const f = await fixture();
    const report = f.owner.reportFailure;
    const capture = vi.fn(() => report);
    Object.defineProperty(f.owner, "reportFailure", { get: capture });
    f.invalidated.mockImplementation(() => f.controller.dispose());
    f.request.mockRejectedValueOnce(new ApiError(403, "MEMBERSHIP_DENIED"));
    await f.controller.load();
    expect(f.invalidated).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(["lease", "consult", "recover"])(
    "passes the %s attempt deadline to the default native fetch while retaining the catalog lifetime",
    async (mode) => {
      const f = await fixture();
      f.controller.dispose();
      if (mode !== "lease")
        f.values.set(
          "entrelacos-gift-media-v1:site-a:assistant-a:gift-a",
          JSON.stringify({
            version: 1,
            siteId: "site-a",
            operatorId: "assistant-a",
            giftId: "gift-a",
            assetId: "asset-a",
          }),
        );
      const waiting = deferred<Response>();
      const entered = deferred<void>();
      let signal!: AbortSignal;
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        const path = String(url);
        if (path.endsWith("/gifts"))
          return new Response(JSON.stringify({ gifts: [gift] }));
        const action = path.endsWith("/finalize")
          ? JSON.parse(String(init?.body)).action
          : undefined;
        if (
          (mode === "lease" && path.endsWith("/uploads")) ||
          (mode === "consult" && path.endsWith("/finalize")) ||
          (mode === "recover" && action === "RECOVER")
        ) {
          signal = init?.signal as AbortSignal;
          entered.resolve();
          return waiting.promise;
        }
        return new Response(JSON.stringify({ status: unknown }));
      });
      const editor = createGiftEditorController(
        "site-a",
        f.changed,
        { ...f.ports, request: undefined, transport },
        f.invalidated,
      );
      cleanup.push(() => editor.dispose());
      await editor.load();
      let action: Promise<void> | undefined;
      if (mode === "lease")
        action = editor.uploadImage("gift-a", file(), "Mesa");
      if (mode === "recover") {
        await vi.waitFor(() =>
          expect(editor.getState().images["gift-a"].busy).toBe(false),
        );
        action = editor.recoverImage("gift-a", "Mesa");
      }
      if (action) void action.catch(() => {});
      await entered.promise;
      try {
        await vi.advanceTimersByTimeAsync(45_000);
        expect(signal.aborted).toBe(true);
        expect(editor.current()).toBe(true);
      } finally {
        waiting.resolve(
          new Response(
            JSON.stringify(
              mode === "lease"
                ? { upload: { id: "asset-a", expiresAt: unknown.expiresAt } }
                : { status: unknown },
            ),
          ),
        );
      }
      if (action) await action.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    },
  );
  it("binds the mounted runtime to the actual owner even when the same ports object changes before rerender", async () => {
    const f = await fixture();
    f.setGift({ ...gift, mediaAssetId: "prior-asset", altText: "Mesa" });
    const lease = deferred<unknown>();
    const entered = deferred<void>();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.request.mockImplementation((path, options) => {
      if (path.endsWith("/uploads")) {
        entered.resolve();
        return lease.promise;
      }
      return original(path, options);
    });
    const dom = await mountEditor(f);
    const edit = [...dom.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Editar presente"),
    );
    if (!edit) throw new Error("Missing gift editor action");
    await act(async () => edit.click());
    const input =
      dom.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file()],
    });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    const send = [...dom.container.querySelectorAll("button")].find((value) =>
      value.textContent?.includes("Enviar imagem"),
    );
    if (!send) throw new Error("Missing upload button");
    await act(async () => {
      send.click();
      await entered.promise;
    });
    const replacement = createPanelActorOwner({
      request: async () => actor,
      now: () => instant,
    });
    await replacement.load();
    cleanup.push(() => replacement.dispose());
    f.ports.owner = replacement;
    await act(async () => {
      lease.resolve({
        upload: { id: "asset-a", expiresAt: unknown.expiresAt },
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(0);
  });
  it.each(["snapshot", "scope"])(
    "rejects disposal inside the editor's final %s callback",
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
  it("does not invoke an old session failure callback captured after editor disposal", async () => {
    const f = await fixture();
    const report = vi.fn();
    Object.defineProperty(f.owner, "reportFailure", {
      get() {
        f.controller.dispose();
        return report;
      },
    });
    f.request.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED"));
    await f.controller.load();
    expect(report).not.toHaveBeenCalled();
  });
  it("acknowledges the image separately from a conflicting description after a lost PATCH response", async () => {
    const f = await fixture();
    await f.controller.load();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.request.mockImplementation(async (path, options) => {
      if (options?.method === "PATCH") {
        f.setGift({
          ...gift,
          mediaAssetId: "asset-a",
          altText: "Descrição concorrente",
        });
        throw new Error("Lost acknowledgement");
      }
      return original(path, options);
    });
    await expect(
      f.controller.uploadImage("gift-a", file(), "Mesa"),
    ).rejects.toThrow("descrição");
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
    expect(f.values.size).toBe(0);
    expect(f.controller.getState().gifts[0].altText).toBe(
      "Descrição concorrente",
    );
    expect(f.controller.getState().previews["gift-a"]).toMatchObject(media);
    expect(f.controller.getState().error).toContain("descrição");
  });
  async function mountEditor(f: Awaited<ReturnType<typeof fixture>>) {
    f.controller.dispose();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () =>
      root.render(
        createElement(GiftEditor, {
          siteId: "site-a",
          ports: f.ports,
          onEligibilityChanged: f.invalidated,
        }),
      ),
    );
    return { container, root };
  }
  it("masks the mounted catalog immediately on replacement of its real session owner", async () => {
    const f = await fixture();
    const dom = await mountEditor(f);
    expect(dom.container.textContent).toContain("Jantar");
    await act(async () => f.owner.invalidate(false));
    expect(dom.container.textContent).not.toContain("Jantar");
    expect(dom.container.textContent).toContain("Verifique sua sessão");
  });
  it("aborts an upload from the mounted field on owner loss and never attaches its late response", async () => {
    const f = await fixture();
    f.setGift({ ...gift, mediaAssetId: "prior-asset", altText: "Mesa" });
    const waiting = deferred<Response>();
    const entered = deferred<void>();
    let signal!: AbortSignal;
    f.transport.mockImplementationOnce((_path, init) => {
      signal = init?.signal as AbortSignal;
      entered.resolve();
      return waiting.promise;
    });
    const dom = await mountEditor(f);
    const edit = [...dom.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Editar presente"),
    );
    if (!edit) throw new Error("Missing gift editor action");
    await act(async () => edit.click());
    const input =
      dom.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file()],
    });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    const send = [...dom.container.querySelectorAll("button")].find((value) =>
      value.textContent?.includes("Enviar imagem"),
    );
    if (!send) throw new Error("Missing upload button");
    await act(async () => {
      send.click();
      await entered.promise;
    });
    await act(async () => f.owner.invalidate(false));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      waiting.resolve(new Response(JSON.stringify({ media }))),
    );
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(0);
    expect(f.values.size).toBe(1);
    expect(dom.container.textContent).not.toContain("Jantar");
  });

  it("reads the current catalog before attachment and clears correlation only after fresh confirmed attachment", async () => {
    const f = await fixture();
    await f.controller.load();
    await f.controller.uploadImage("gift-a", file(), "Mesa");
    const calls = f.request.mock.calls;
    const patch = calls.findIndex(([, options]) => options?.method === "PATCH");
    expect(calls[patch - 1][0]).toBe("/v1/sites/site-a/gifts");
    expect(calls[patch + 1][0]).toBe("/v1/sites/site-a/gifts");
    expect(calls[patch][1]).toMatchObject({
      body: { mediaAssetId: "asset-a", altText: "Mesa" },
    });
    expect(f.values.size).toBe(0);
    expect(f.controller.getState().previews["gift-a"]).toMatchObject(media);
  });
  it("treats a lost PATCH acknowledgement as inspection and never overwrites a different image", async () => {
    const f = await fixture();
    await f.controller.load();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.request.mockImplementation(async (path, options) => {
      if (options?.method === "PATCH") {
        f.setGift({
          ...gift,
          mediaAssetId: "other-asset",
          altText: "Outra imagem",
        });
        throw new Error("Lost acknowledgement");
      }
      return original(path, options);
    });
    await expect(
      f.controller.uploadImage("gift-a", file(), "Mesa"),
    ).rejects.toThrow();
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
    expect(f.values.size).toBe(1);
    expect(f.controller.getState().gifts[0].mediaAssetId).toBe("other-asset");
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
  });
  it("accepts an acknowledged fresh attachment after a lost PATCH response", async () => {
    const f = await fixture();
    await f.controller.load();
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.request.mockImplementation(async (path, options) => {
      if (options?.method === "PATCH") {
        await original(path, options);
        throw new Error("Lost acknowledgement");
      }
      return original(path, options);
    });
    await f.controller.uploadImage("gift-a", file(), "Mesa");
    expect(f.values.size).toBe(0);
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
  });
  it("does not attach a late binary result after actual owner replacement", async () => {
    const f = await fixture();
    await f.controller.load();
    const waiting = deferred<Response>();
    const entered = deferred<void>();
    f.transport.mockImplementationOnce(() => {
      entered.resolve();
      return waiting.promise;
    });
    const result = f.controller.uploadImage("gift-a", file(), "Mesa");
    await entered.promise;
    f.owner.invalidate(false);
    const count = f.changed.mock.calls.length;
    waiting.resolve(new Response(JSON.stringify({ media })));
    await expect(result).rejects.toThrow();
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(0);
    expect(f.changed.mock.calls).toHaveLength(count);
    expect(f.values.size).toBe(1);
  });
  it("ignores an old catalog read and its callbacks after scope disposal", async () => {
    const f = await fixture();
    const waiting = deferred<unknown>();
    f.request.mockImplementationOnce(() => waiting.promise);
    const result = f.controller.load();
    f.controller.dispose();
    const count = f.changed.mock.calls.length;
    waiting.resolve({ gifts: [gift] });
    await result;
    expect(f.changed.mock.calls).toHaveLength(count);
    expect(f.invalidated).not.toHaveBeenCalled();
  });
  it("reserves the catalog media action synchronously before asynchronous hashing", async () => {
    const f = await fixture();
    await f.controller.load();
    const waiting = deferred<Response>();
    const entered = deferred<void>();
    f.transport.mockImplementationOnce(() => {
      entered.resolve();
      return waiting.promise;
    });
    const first = f.controller.uploadImage("gift-a", file(), "Mesa");
    await entered.promise;
    await expect(
      f.controller.uploadImage("gift-a", file(), "Mesa"),
    ).rejects.toThrow();
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/uploads")),
    ).toHaveLength(1);
    waiting.resolve(new Response(JSON.stringify({ media })));
    await first;
  });
  it("reload consults retained correlation without automatic recovery, upload or catalog PATCH", async () => {
    const f = await fixture();
    f.values.set(
      "entrelacos-gift-media-v1:site-a:assistant-a:gift-a",
      JSON.stringify({
        version: 1,
        siteId: "site-a",
        operatorId: "assistant-a",
        giftId: "gift-a",
        assetId: "asset-a",
      }),
    );
    await f.controller.load();
    await vi.waitFor(() =>
      expect(
        f.request.mock.calls.some(([path]) => path.endsWith("/finalize")),
      ).toBe(true),
    );
    const consultations = f.request.mock.calls.filter(([path]) =>
      path.endsWith("/finalize"),
    );
    expect(consultations.map(([, options]) => options?.body)).toEqual([{}]);
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(0);
    expect(f.values.size).toBe(1);
  });
});

describe("saved gift previews without recovery state", () => {
  const saved: GiftItem = { ...gift, mediaAssetId: media.id, altText: "Mesa" };
  const finalized = () => ({
    status: {
      ...unknown,
      state: "FINALIZED",
      expiresAt: new Date(instant - 300000).toISOString(),
      media: { ...media },
    },
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  async function previewFixture() {
    const f = await fixture();
    f.setGift({ ...saved });
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.request.mockImplementation((path, options) =>
      path.endsWith("/finalize")
        ? Promise.resolve(finalized())
        : original(path, options),
    );
    return f;
  }
  const consultations = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.request.mock.calls.filter(([path]) => path.endsWith("/finalize"));
  async function mountSaved(f: Awaited<ReturnType<typeof fixture>>) {
    f.controller.dispose();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    const render = () =>
      createElement(GiftEditor, {
        siteId: "site-a",
        ports: f.ports,
        onEligibilityChanged: f.invalidated,
      });
    await act(async () => {
      root.render(render());
      await flush();
    });
    return { container, root, render };
  }
  it.each(["DRAFT", "PUBLISHED"] as const)(
    "loads a marker-free %s asset through exact JSON consultation and fresh attachment confirmation",
    async (publicationState) => {
      const f = await previewFixture();
      f.setGift({ ...saved, publicationState });
      await f.controller.load();
      await flush();
      expect(f.controller.getState().previews["gift-a"]).toEqual(media);
      expect(
        f.request.mock.calls.map(([path, options]) => [
          path,
          options?.method,
          options?.body,
        ]),
      ).toEqual([
        ["/v1/sites/site-a/gifts", undefined, undefined],
        ["/v1/sites/site-a/gift-media/asset-a/finalize", "POST", {}],
        ["/v1/sites/site-a/gifts", undefined, undefined],
      ]);
      expect(f.values.size).toBe(0);
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.controller.getState().images["gift-a"]).toMatchObject({
        state: "IDLE",
        retained: false,
        canRetrySameBytes: false,
        media: null,
      });
    },
  );
  it.each([
    ["unknown", { status: unknown }],
    ["processing", { status: { ...unknown, state: "PROCESSING" } }],
    ["failed", { status: { ...unknown, state: "FAILED" } }],
    ["expired", { status: { ...unknown, state: "EXPIRED" } }],
    [
      "pending retry",
      { status: { ...unknown, state: "PENDING", canRetrySameBytes: true } },
    ],
    [
      "foreign status",
      {
        status: {
          ...finalized().status,
          siteId: "site-b",
          media: { ...media, siteId: "site-b" },
        },
      },
    ],
    [
      "foreign asset",
      {
        status: {
          ...finalized().status,
          assetId: "asset-b",
          media: { ...media, id: "asset-b" },
        },
      },
    ],
    [
      "media mismatch",
      { status: { ...finalized().status, media: { ...media, id: "asset-b" } } },
    ],
    [
      "unsafe url",
      {
        status: {
          ...finalized().status,
          media: {
            ...media,
            url: "https://media.example.test/image.webp?token=unsafe",
          },
        },
      },
    ],
    ["extra field", { ...finalized(), extra: true }],
  ])(
    "keeps %s as a placeholder without changing recovery permission",
    async (_name, response) => {
      const f = await previewFixture();
      f.request.mockImplementation(async (path) =>
        path.endsWith("/finalize") ? response : { gifts: [saved] },
      );
      await f.controller.load();
      await flush();
      expect(consultations(f)).toHaveLength(1);
      expect(f.request.mock.calls).toHaveLength(2);
      expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
      expect(f.controller.getState().images["gift-a"]).toMatchObject({
        state: "IDLE",
        retained: false,
        canRetrySameBytes: false,
      });
      expect(f.controller.getState().error).toBe("");
      expect(f.values.size).toBe(0);
    },
  );
  it.each([
    ["removed asset", { ...saved, mediaAssetId: null, altText: "" }],
    ["replaced asset", { ...saved, mediaAssetId: "asset-b" }],
    ["caption", { ...saved, altText: "Outro texto" }],
    ["publication", { ...saved, publicationState: "PUBLISHED" }],
    [
      "revision",
      { ...saved, updatedAt: new Date(instant + 1000).toISOString() },
    ],
    ["deleted gift", null],
  ])("does not adopt a fresh conflicting %s", async (_name, changed) => {
    const f = await previewFixture();
    let reads = 0;
    f.request.mockImplementation(async (path) =>
      path.endsWith("/finalize")
        ? finalized()
        : {
            gifts: ++reads === 1 ? [saved] : changed ? [changed] : [],
          },
    );
    await f.controller.load();
    await flush();
    expect(consultations(f)).toHaveLength(1);
    expect(reads).toBe(2);
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
    expect(f.controller.getState().gifts[0]).toEqual(saved);
    expect(f.values.size).toBe(0);
    expect(
      f.request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
  });
  it("deduplicates shared assets and confirms all candidate attachments in one fresh catalog", async () => {
    const f = await previewFixture();
    const other = { ...saved, id: "gift-b", altText: "Outra mesa" };
    f.request.mockImplementation(async (path) =>
      path.endsWith("/finalize") ? finalized() : { gifts: [saved, other] },
    );
    await f.controller.load();
    await flush();
    expect(consultations(f)).toHaveLength(1);
    expect(f.request.mock.calls).toHaveLength(3);
    expect(f.controller.getState().previews).toEqual({
      "gift-a": media,
      "gift-b": media,
    });
  });
  it("serializes distinct assets while ordinary catalog loading finishes independently", async () => {
    const f = await previewFixture();
    const waiting = deferred<unknown>();
    const other = { ...saved, id: "gift-b", mediaAssetId: "asset-b" };
    f.request.mockImplementation(async (path) => {
      if (path.includes("/asset-a/finalize")) return waiting.promise;
      if (path.includes("/asset-b/finalize"))
        return {
          status: {
            ...finalized().status,
            assetId: "asset-b",
            media: { ...media, id: "asset-b" },
          },
        };
      return { gifts: [saved, other] };
    });
    await f.controller.load();
    await flush();
    expect(f.controller.getState().loading).toBe(false);
    expect(f.controller.getState().busy).toBe(false);
    expect(consultations(f)).toHaveLength(1);
    waiting.resolve(finalized());
    await flush();
    expect(consultations(f)).toHaveLength(2);
    expect(f.controller.getState().previews["gift-b"]?.id).toBe("asset-b");
  });
  it("masks a proved URL before a new load and never dispatches its replacement before actual settlement", async () => {
    const f = await previewFixture();
    await f.controller.load();
    await flush();
    expect(f.controller.getState().previews["gift-a"]).toEqual(media);
    const waiting = deferred<unknown>();
    f.request.mockImplementationOnce(() => waiting.promise);
    const reload = f.controller.load();
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
    waiting.resolve({ gifts: [saved] });
    await reload;
    await flush();
    expect(f.controller.getState().previews["gift-a"]).toEqual(media);
  });
  it("does not publish a response after same-object request replacement", async () => {
    const f = await previewFixture();
    const waiting = deferred<unknown>();
    f.request.mockImplementation(async (path) =>
      path.endsWith("/finalize") ? waiting.promise : { gifts: [saved] },
    );
    await f.controller.load();
    await flush();
    expect(consultations(f)).toHaveLength(1);
    const replacement = vi.fn(async () => finalized());
    f.ports.request = replacement;
    waiting.resolve(finalized());
    await flush();
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
    expect(replacement).not.toHaveBeenCalled();
  });
  it("masks mutable selected tuple changes synchronously at projection time", async () => {
    const f = await previewFixture();
    await f.controller.load();
    await flush();
    expect(f.controller.getState().previews["gift-a"]).toEqual(media);
    f.controller.getState().gifts[0].altText = "Changed outside snapshot";
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
  });
  it.each(["consultation", "confirmation"] as const)(
    "aborts the %s child at 45 seconds and retains its actual promise before replacement",
    async (phase) => {
      const f = await previewFixture();
      const waiting = deferred<unknown>();
      let signal!: AbortSignal;
      let reads = 0;
      f.request.mockImplementation(async (path, options) => {
        if (!path.endsWith("/finalize")) {
          if (++reads === 2 && phase === "confirmation") {
            signal = (options as { signal: AbortSignal }).signal;
            return waiting.promise;
          }
          return { gifts: [saved] };
        }
        if (phase === "consultation") {
          signal = (options as { signal: AbortSignal }).signal;
          return waiting.promise;
        }
        return finalized();
      });
      await f.controller.load();
      await flush();
      expect(signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(signal.aborted).toBe(true);
      await f.controller.load();
      await flush();
      expect(consultations(f)).toHaveLength(1);
      expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
      waiting.resolve(
        phase === "consultation" ? finalized() : { gifts: [saved] },
      );
      await flush();
      expect(consultations(f)).toHaveLength(2);
      expect(f.controller.getState().previews["gift-a"]).toEqual(media);
    },
  );
  it("does not clear or rewrite a retained upload marker while reading a different saved asset", async () => {
    const f = await previewFixture();
    const marker = JSON.stringify({
      version: 1,
      siteId: "site-a",
      operatorId: "assistant-a",
      giftId: "gift-a",
      assetId: "pending-asset",
    });
    f.values.set("entrelacos-gift-media-v1:site-a:assistant-a:gift-a", marker);
    f.request.mockImplementation(async (path) => {
      if (path.includes("/pending-asset/finalize"))
        return { status: { ...unknown, assetId: "pending-asset" } };
      return path.endsWith("/finalize") ? finalized() : { gifts: [saved] };
    });
    await f.controller.load();
    await flush();
    expect(f.controller.getState().previews["gift-a"]).toEqual(media);
    expect(
      f.values.get("entrelacos-gift-media-v1:site-a:assistant-a:gift-a"),
    ).toBe(marker);
    expect(f.controller.getState().images["gift-a"]).toMatchObject({
      state: "UNKNOWN",
      retained: true,
    });
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/uploads")),
    ).toHaveLength(0);
  });
  it("checks native scope after response getters before confirmation or notification", async () => {
    const f = await previewFixture();
    const result = finalized();
    let notifications = 0;
    Object.defineProperty(result.status, "media", {
      get() {
        f.controller.dispose();
        notifications = f.changed.mock.calls.length;
        return media;
      },
    });
    f.request.mockImplementation(async (path) =>
      path.endsWith("/finalize") ? result : { gifts: [saved] },
    );
    await f.controller.load();
    await flush();
    expect(consultations(f)).toHaveLength(1);
    expect(f.request.mock.calls).toHaveLength(2);
    expect(f.changed.mock.calls).toHaveLength(notifications);
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
  });
  it("does not invoke a reentrant session reporter after preview failure disposal", async () => {
    const f = await previewFixture();
    const report = vi.fn();
    Object.defineProperty(f.owner, "reportFailure", {
      get() {
        f.controller.dispose();
        return report;
      },
    });
    f.request.mockImplementation(async (path) => {
      if (path.endsWith("/finalize")) throw new ApiError(401, "UNAUTHORIZED");
      return { gifts: [saved] };
    });
    await f.controller.load();
    await flush();
    expect(consultations(f)).toHaveLength(1);
    expect(report).not.toHaveBeenCalled();
    expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
  });
  it.each([404, 503])(
    "keeps a %s preview failure separate from catalog and recovery errors",
    async (code) => {
      const f = await previewFixture();
      f.request.mockImplementation(async (path) => {
        if (path.endsWith("/finalize"))
          throw new ApiError(code, "SERVICE_UNAVAILABLE");
        return { gifts: [saved] };
      });
      await f.controller.load();
      await flush();
      expect(consultations(f)).toHaveLength(1);
      expect(f.controller.getState().previews["gift-a"]).toBeUndefined();
      expect(f.controller.getState().error).toBe("");
      expect(f.controller.getState().images["gift-a"].error).toBe("");
      expect(f.invalidated).not.toHaveBeenCalled();
    },
  );
  it("renders the stored URL/current caption in the mounted editor and removes it after owner loss", async () => {
    const f = await previewFixture();
    const dom = await mountSaved(f);
    const image = dom.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(media.url);
    expect(image?.getAttribute("alt")).toBe(saved.altText);
    await act(async () => f.owner.invalidate(false));
    expect(dom.container.querySelector("img")).toBeNull();
    expect(dom.container.textContent).toContain("Verifique sua sessão");
  });
  it.each(["consultation", "confirmation"] as const)(
    "transfers the pending mounted %s drain across actual owner replacement",
    async (phase) => {
      const f = await previewFixture();
      const waiting = deferred<unknown>();
      let signal!: AbortSignal;
      let reads = 0;
      let held = false;
      f.request.mockImplementation(async (path, options) => {
        if (path.endsWith("/finalize")) {
          if (!held && phase === "consultation") {
            held = true;
            signal = (options as { signal: AbortSignal }).signal;
            return waiting.promise;
          }
          return finalized();
        }
        if (++reads === 2 && phase === "confirmation") {
          held = true;
          signal = (options as { signal: AbortSignal }).signal;
          return waiting.promise;
        }
        return { gifts: [saved] };
      });
      const dom = await mountSaved(f);
      expect(signal).toBeDefined();
      expect(dom.container.querySelector("img")).toBeNull();
      const replacement = createPanelActorOwner({
        request: async () => actor,
        now: () => instant,
      });
      await replacement.load();
      cleanup.push(() => replacement.dispose());
      f.ports.owner = replacement;
      await act(async () => {
        dom.root.render(dom.render());
        await flush();
      });
      expect(signal.aborted).toBe(true);
      expect(consultations(f)).toHaveLength(1);
      expect(dom.container.querySelector("img")).toBeNull();
      await act(async () => {
        waiting.resolve(
          phase === "consultation" ? finalized() : { gifts: [saved] },
        );
        await flush();
      });
      expect(consultations(f)).toHaveLength(2);
      expect(dom.container.querySelector("img")?.getAttribute("src")).toBe(
        media.url,
      );
    },
  );

  it.each(["consultation", "confirmation"] as const)(
    "preserves the mounted %s drain through StrictMode and replaced transport ports",
    async (phase) => {
      const f = await previewFixture();
      f.controller.dispose();
      const waiting = deferred<unknown>();
      let held = false;
      let reads = 0;
      let signal!: AbortSignal;
      const original = f.request.getMockImplementation();
      if (!original) throw new Error("Missing fixture implementation");
      f.request.mockImplementation(async (path, options) => {
        if (
          !held &&
          ((phase === "consultation" && path.endsWith("/finalize")) ||
            (phase === "confirmation" &&
              path.endsWith("/gifts") &&
              ++reads > 2))
        ) {
          held = true;
          signal = options?.signal as AbortSignal;
          return waiting.promise;
        }
        return original(path, options);
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mounted.push(root);
      const render = (ports: typeof f.ports) =>
        createElement(
          StrictMode,
          null,
          createElement(GiftEditor, {
            siteId: "site-a",
            ports,
            onEligibilityChanged: f.invalidated,
          }),
        );
      await act(async () => {
        root.render(render(f.ports));
        await flush();
      });
      expect(signal).toBeDefined();
      const replacement = vi.fn(async (path: string) =>
        path.endsWith("/finalize") ? finalized() : { gifts: [saved] },
      );
      await act(async () => {
        root.render(render({ ...f.ports, request: replacement }));
        await flush();
      });
      expect(signal.aborted).toBe(true);
      expect(
        replacement.mock.calls.filter(([path]) => path.endsWith("/finalize")),
      ).toHaveLength(0);
      await act(async () => {
        waiting.resolve(
          phase === "consultation" ? finalized() : { gifts: [saved] },
        );
        await flush();
      });
      expect(
        replacement.mock.calls.filter(([path]) => path.endsWith("/finalize")),
      ).toHaveLength(1);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        media.url,
      );
    },
  );
  it.each(["consultation", "confirmation"] as const)(
    "links the %s deadline to the actual default native fetch",
    async (phase) => {
      const f = await previewFixture();
      f.controller.dispose();
      const waiting = deferred<Response>();
      let reads = 0;
      let signal!: AbortSignal;
      const transport = vi.fn<typeof fetch>(async (path, options) => {
        if (String(path).endsWith("/finalize")) {
          if (phase === "consultation") {
            signal = options?.signal as AbortSignal;
            return waiting.promise;
          }
          return new Response(JSON.stringify(finalized()));
        }
        if (++reads === 2 && phase === "confirmation") {
          signal = options?.signal as AbortSignal;
          return waiting.promise;
        }
        return new Response(JSON.stringify({ gifts: [saved] }));
      });
      const editor = createGiftEditorController(
        "site-a",
        f.changed,
        { ...f.ports, request: undefined, transport },
        f.invalidated,
      );
      cleanup.push(() => editor.dispose());
      await editor.load();
      await flush();
      expect(signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(signal.aborted).toBe(true);
      expect(editor.getState().previews["gift-a"]).toBeUndefined();
      waiting.resolve(
        new Response(
          JSON.stringify(
            phase === "consultation" ? finalized() : { gifts: [saved] },
          ),
        ),
      );
      await flush();
      expect(editor.getState().previews["gift-a"]).toBeUndefined();
      expect(transport.mock.calls).toHaveLength(
        phase === "consultation" ? 2 : 3,
      );
    },
  );

  it("does not report an old preview denial after eligibility callback starts a replacement catalog generation", async () => {
    const f = await previewFixture();
    let denied = false;
    f.request.mockImplementation(async (path) => {
      if (path.endsWith("/finalize")) {
        if (!denied) {
          denied = true;
          throw new ApiError(409, "RECEIVING_NOT_READY");
        }
        return finalized();
      }
      return { gifts: [saved] };
    });
    const report = vi
      .spyOn(f.owner, "reportFailure")
      .mockImplementation(() => {});
    f.invalidated.mockImplementation(() => {
      void f.controller.load();
    });
    await f.controller.load();
    await flush();
    expect(f.invalidated).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(consultations(f)).toHaveLength(2);
    expect(f.controller.getState().previews["gift-a"]).toEqual(media);
  });

  it.each([
    ["request", false],
    ["transport", false],
    ["clock", false],
    ["request", true],
    ["transport", true],
    ["clock", true],
  ] as const)(
    "rejects mounted in-place %s replacement%s after external callbacks",
    async (port, reentrant) => {
      const f = await previewFixture();
      const waiting = deferred<unknown>();
      f.request.mockImplementation(async (path) =>
        path.endsWith("/finalize") ? waiting.promise : { gifts: [saved] },
      );
      const replacementRequest = vi.fn(async () => finalized());
      const replacementTransport = vi.fn<typeof fetch>(
        async () => new Response("{}"),
      );
      let replace = false;
      const swap = () => {
        if (port === "request") f.ports.request = replacementRequest;
        if (port === "transport") f.ports.transport = replacementTransport;
        if (port === "clock") f.ports.now = () => Date.now() + 1;
      };
      if (reentrant)
        f.ports.isCurrent = () => {
          if (replace) {
            replace = false;
            swap();
          }
          return true;
        };
      const originalRequest = f.request;
      const dom = await mountSaved(f);
      expect(consultations(f)).toHaveLength(1);
      const count = originalRequest.mock.calls.length;
      if (reentrant) replace = true;
      else swap();
      await act(async () => {
        waiting.resolve(finalized());
        await flush();
      });
      expect(originalRequest.mock.calls).toHaveLength(count);
      expect(dom.container.querySelector("img")).toBeNull();
      expect(replacementRequest).not.toHaveBeenCalled();
      expect(replacementTransport).not.toHaveBeenCalled();
    },
  );

  it.each([
    "RECEIVING_NOT_READY",
    "SITE_INACTIVE",
    "SITE_EXPIRED",
    "SITE_INELIGIBLE",
  ])(
    "stops a pass after current %s even with an earlier positive asset and a no-op eligibility callback",
    async (code) => {
      const f = await previewFixture();
      const other = { ...saved, id: "gift-b", mediaAssetId: "asset-b" };
      f.request.mockImplementation(async (path) => {
        if (path.includes("/asset-a/finalize")) return finalized();
        if (path.includes("/asset-b/finalize")) throw new ApiError(409, code);
        return { gifts: [saved, other] };
      });
      await f.controller.load();
      await flush();
      expect(consultations(f)).toHaveLength(2);
      expect(f.invalidated).toHaveBeenCalledOnce();
      expect(
        f.request.mock.calls.filter(([path]) => path.endsWith("/gifts")),
      ).toHaveLength(1);
      expect(f.controller.getState().previews).toEqual({});
      expect(f.controller.getState().gifts).toEqual([saved, other]);
      expect(f.controller.getState().error).toBe("");
      expect(f.values.size).toBe(0);
    },
  );

  it.each([404, 503])(
    "keeps an earlier positive candidate after an ordinary %s asset failure",
    async (status) => {
      const f = await previewFixture();
      const other = { ...saved, id: "gift-b", mediaAssetId: "asset-b" };
      f.request.mockImplementation(async (path) => {
        if (path.includes("/asset-a/finalize")) return finalized();
        if (path.includes("/asset-b/finalize"))
          throw new ApiError(status, "SERVICE_UNAVAILABLE");
        return { gifts: [saved, other] };
      });
      await f.controller.load();
      await flush();
      expect(consultations(f)).toHaveLength(2);
      expect(f.invalidated).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.filter(([path]) => path.endsWith("/gifts")),
      ).toHaveLength(2);
      expect(f.controller.getState().previews).toEqual({ "gift-a": media });
      expect(f.controller.getState().images["gift-b"]).toMatchObject({
        state: "IDLE",
        retained: false,
      });
      expect(f.controller.getState().error).toBe("");
    },
  );
});
