// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftRegistry } from "./GiftRegistry";
import { writePendingGiftCheckout } from "./giftCheckoutStorage";

describe("runtime gift registry initial render", () => {
  it("preserves runtime identity until the API transport or scope changes", () => {
    const props = {
      siteId: "wedding-a",
      apiOrigin: "https://api.example.test",
      fetcher: vi.fn(),
    };
    const first = GiftRegistry(props).props.runtimeKey;
    expect(GiftRegistry({ ...props }).props.runtimeKey).toBe(first);
    expect(
      GiftRegistry({ ...props, fetcher: vi.fn() }).props.runtimeKey,
    ).not.toBe(first);
    expect(
      GiftRegistry({ ...props, siteId: "wedding-b" }).props.runtimeKey,
    ).not.toBe(first);
    expect(GiftRegistry({ ...props, demo: true }).props.runtimeKey).not.toBe(
      first,
    );
  });
  it("does not fetch or expose a catalog/price on server rendering", () => {
    const fetcher = vi.fn();
    const html = renderToStaticMarkup(
      createElement(GiftRegistry, {
        siteId: "wedding-a",
        apiOrigin: "https://api.example.test",
        fetcher,
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).not.toContain("Valor simbólico:");
    expect(html).not.toContain("Escolher presente");
    expect(html).not.toContain("Recebido");
    expect(html).toContain("data-gift-runtime");
  });
  it("keeps missing/invalid public configuration closed without crashing other wedding sections", () => {
    const fetcher = vi.fn();
    expect(() =>
      renderToStaticMarkup(
        createElement(GiftRegistry, { siteId: "", apiOrigin: "", fetcher }),
      ),
    ).not.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("mounted server catalog runtime", () => {
  const mounts: Array<{ root: Root; surface: HTMLElement; active: boolean }> =
    [];
  const page = (siteId = "wedding-a", page = 1, q = "") => ({
    siteId,
    mode: "sandbox",
    page,
    pageSize: 20,
    q,
    total: q ? 0 : 25,
    totalPages: q ? 1 : 2,
    hasNext: !q && page === 1,
    gifts: q
      ? []
      : Array.from({ length: page === 1 ? 20 : 5 }, (_, i) => ({
          id: `gift-${(page - 1) * 20 + i}`,
          siteId,
          title: `Dinner ${(page - 1) * 20 + i}`,
          description: "Symbolic",
          nominalCents: 10000,
          currency: "BRL",
          image: null,
          sortOrder: (page - 1) * 20 + i,
        })),
  });
  const reply = (value: unknown, status = 200) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Uint8Array.from(new TextEncoder().encode(JSON.stringify(value))),
          );
          controller.close();
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  async function flush() {
    for (let i = 0; i < 24; i++) await Promise.resolve();
  }
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
        this.dispatchEvent(new Event("close"));
      },
    });
  });
  afterEach(async () => {
    await act(async () => {
      for (const m of mounts) {
        if (m.active) m.root.unmount();
        m.surface.remove();
      }
      await flush();
    });
    mounts.length = 0;
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function mount(fetcher: typeof fetch, siteId = "wedding-a") {
    const surface = document.createElement("section");
    surface.dataset.giftSection = "";
    surface.hidden = true;
    document.body.append(surface);
    const root = createRoot(surface);
    const entry = { root, surface, active: true };
    mounts.push(entry);
    await act(async () => {
      root.render(
        createElement(GiftRegistry, {
          siteId,
          apiOrigin: "https://api.example.test",
          fetcher,
        }),
      );
      await flush();
    });
    await act(flush);
    return entry;
  }
  const query = (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    return {
      siteId: u.pathname.split("/")[4],
      page: Number(u.searchParams.get("page") || 1),
      q: u.searchParams.get("q") || "",
    };
  };
  async function search(surface: HTMLElement, value: string) {
    const input = surface.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!input || !setter) throw new Error("Missing native search input");
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
  }
  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await flush();
    });
  }
  async function click(surface: HTMLElement, label: string) {
    const b = Array.from(surface.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    );
    expect(b).toBeDefined();
    if (!b) throw new Error("Missing catalog control");
    await act(async () => {
      b.click();
      await flush();
    });
  }
  it("debounces300ms after the last input, resets page1 and retains controls on an empty match", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
    const { surface } = await mount(fetcher);
    expect(surface.hidden).toBe(false);
    await search(surface, "first");
    expect(surface.textContent).not.toContain("25 presentes");
    await advance(100);
    await search(surface, " last ");
    await advance(299);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(surface.querySelectorAll("button")).not.toHaveLength(0);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(query(fetcher.mock.calls[1][0])).toMatchObject({
      page: 1,
      q: "last",
    });
    expect(surface.hidden).toBe(false);
    expect(surface.querySelector('input[type="search"]')).not.toBeNull();
    expect(surface.textContent).toContain("Nenhum presente");
  });
  it("queues only the latest intent behind actual prior settlement and never overlaps30s refresh", async () => {
    let resolve!: (r: Response) => void;
    const waiting = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetcher = vi.fn((url) => {
      const q = query(url);
      return fetcher.mock.calls.length === 2
        ? waiting
        : Promise.resolve(reply(page(q.siteId, q.page, q.q)));
    });
    const { surface } = await mount(fetcher);
    try {
      await click(surface, "Próxima página");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(query(fetcher.mock.calls[1][0]).page).toBe(2);
      await search(surface, "stale");
      await advance(300);
      await search(surface, "latest");
      await advance(300);
      await advance(30000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolve(reply(page("wedding-a", 2)));
        await flush();
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(query(fetcher.mock.calls[2][0])).toMatchObject({
        page: 1,
        q: "latest",
      });
      expect(surface.textContent).not.toContain("Dinner 20");
    } finally {
      resolve(reply(page("wedding-a", 2)));
      await act(flush);
    }
  });
  it("retains one actual job across site replacement and publishes only the replacement scope", async () => {
    let resolve!: (r: Response) => void;
    const waiting = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetcher = vi.fn((url) => {
      const q = query(url);
      return fetcher.mock.calls.length === 1
        ? waiting
        : Promise.resolve(reply(page(q.siteId, q.page, q.q)));
    });
    const m = await mount(fetcher);
    try {
      await act(async () => {
        m.root.render(
          createElement(GiftRegistry, {
            siteId: "wedding-b",
            apiOrigin: "https://api.example.test",
            fetcher,
          }),
        );
        await flush();
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve(reply(page()));
        await flush();
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(query(fetcher.mock.calls[1][0]).siteId).toBe("wedding-b");
      expect(m.surface.hidden).toBe(false);
    } finally {
      resolve(reply(page()));
      await act(flush);
    }
  });
  it("does not close the selected dialog when search or refresh changes the catalog", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
    const { surface } = await mount(fetcher);
    await click(surface, "Escolher presente");
    expect(surface.querySelector("dialog")?.open).toBe(true);
    await search(surface, "none");
    await advance(300);
    expect(surface.querySelector("dialog")?.open).toBe(true);
    await advance(30000);
    expect(surface.querySelector("dialog")?.open).toBe(true);
  });
  it("preserves the exact UNKNOWN marker and checkout locks through catalog intents", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", {
      quoteId: "quote-a",
      requestId: "request-a",
      recoveryToken: "A".repeat(43),
      method: "PIX",
      mode: "sandbox",
    });
    const snapshot = JSON.stringify({ ...window.sessionStorage });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
    const { surface } = await mount(fetcher);
    expect(surface.textContent).toContain("Não inicie outro pagamento");
    expect(
      Array.from(surface.querySelectorAll("button"))
        .filter((b) => b.textContent === "Aguarde…")
        .every((b) => b.disabled),
    ).toBe(true);
    await search(surface, "none");
    await advance(300);
    expect(JSON.stringify({ ...window.sessionStorage })).toBe(snapshot);
    expect(surface.textContent).toContain("Não inicie outro pagamento");
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });
  it("keeps reentrant latest input authoritative when abort invokes another input intent", async () => {
    let resolve!: (r: Response) => void;
    const waiting = new Promise<Response>((r) => {
      resolve = r;
    });
    let surface!: HTMLElement;
    const fetcher = vi.fn((url, init) => {
      const q = query(url);
      if (fetcher.mock.calls.length === 2) {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const input = surface.querySelector<HTMLInputElement>(
              'input[type="search"]',
            );
            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )?.set;
            if (!input || !setter)
              throw new Error("Missing native search input");
            setter.call(input, "inner");
            input.dispatchEvent(new Event("input", { bubbles: true }));
          },
          { once: true },
        );
        return waiting;
      }
      return Promise.resolve(reply(page(q.siteId, q.page, q.q)));
    });
    const m = await mount(fetcher);
    surface = m.surface;
    try {
      await click(surface, "Próxima página");
      await search(surface, "outer");
      await advance(300);
      await act(async () => {
        resolve(reply(page("wedding-a", 2)));
        await flush();
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(query(fetcher.mock.calls[2][0]).q).toBe("inner");
      expect(
        surface.querySelector<HTMLInputElement>('input[type="search"]')?.value,
      ).toBe("inner");
    } finally {
      resolve(reply(page("wedding-a", 2)));
      await act(flush);
    }
  });

  it("aborts unmount but observes the late native body and its actual deferred cancellation", async () => {
    let resolve!: (r: Response) => void;
    const waiting = new Promise<Response>((r) => {
      resolve = r;
    });
    let release!: () => void;
    const completion = new Promise<void>((r) => {
      release = r;
    });
    const cancel = vi.fn(() => completion);
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    const fetcher = vi.fn<typeof fetch>(() => waiting);
    const m = await mount(fetcher as typeof fetch);
    try {
      await act(async () => {
        m.root.unmount();
        m.active = false;
        await flush();
      });
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      await act(async () => {
        resolve(new Response(body));
        await flush();
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(m.surface.hidden).toBe(true);
    } finally {
      release();
      resolve(new Response());
      await act(flush);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an initially unavailable catalog closed", async () => {
    const fetcher = vi.fn(async () =>
      reply({ code: "RECEIVING_NOT_READY" }, 409),
    );
    const { surface } = await mount(fetcher);
    expect(surface.hidden).toBe(true);
    expect(surface.querySelector('input[type="search"]')).toBeNull();
  });
});
