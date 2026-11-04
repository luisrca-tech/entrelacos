// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showcaseBuildEnvironment } from "../../../scripts/showcaseBuildEnvironment";
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
    expect(
      GiftRegistry({ ...props, liveDemoSiteId: "wedding-a" }).props.runtimeKey,
    ).not.toBe(first);
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
    expect(html).not.toContain("Valor:");
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function mount(
    fetcher: typeof fetch,
    siteId = "wedding-a",
    policy: { demo?: boolean; liveDemoSiteId?: string } = {},
  ) {
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
          ...policy,
        }),
      );
      await flush();
    });
    await act(flush);
    return entry;
  }
  it("renders a server demonstration catalog without initiating quotes or checkouts", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
      reply({ ...page(), mode: "demonstration" }),
    );
    const { surface } = await mount(fetcher as typeof fetch, "wedding-a", {
      demo: true,
    });
    expect(surface.hidden).toBe(false);
    expect(surface.textContent).toContain("Contribuições indisponíveis");
    expect(surface.querySelector("h3")?.textContent).toBe("Dinner 0");
    expect(surface.textContent).toContain("100,00");
    expect(surface.textContent).not.toContain("Escolher presente");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      "/v1/public/sites/wedding-a/gifts",
    );
  });
  const query = (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    return {
      siteId: u.pathname.split("/")[4],
      page: Number(u.searchParams.get("page") || 1),
      q: u.searchParams.get("q") || "",
    };
  };
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
  it("pages the catalog without a guest search field", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
    const { surface } = await mount(fetcher);
    expect(surface.hidden).toBe(false);
    expect(surface.querySelector('input[type="search"]')).toBeNull();
    expect(surface.textContent).not.toContain("Buscar presentes");
    await click(surface, "Próxima página");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(query(fetcher.mock.calls[1][0])).toMatchObject({ page: 2, q: "" });
    expect(surface.textContent).toContain("Página 2 de 2");
    expect(surface.textContent).toContain("Dinner 20");
  });
  it("keeps the rendered cards during a slow or failed background refresh", async () => {
    let resolve!: (response: Response) => void;
    const waiting = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(page()))
      .mockReturnValueOnce(waiting)
      .mockResolvedValueOnce(
        reply({
          ...page(),
          mode: "disabled",
          gifts: [],
          total: 0,
          totalPages: 1,
          hasNext: false,
        }),
      );
    const { surface } = await mount(fetcher);
    const card = surface.querySelector("article");
    expect(card).not.toBeNull();

    await advance(30000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(surface.querySelector("article")).toBe(card);
    expect(surface.textContent).not.toContain("Carregando presentes");

    await act(async () => {
      resolve(reply({}, 503));
      await flush();
    });
    expect(surface.querySelector("article")).toBe(card);
    expect(surface.hidden).toBe(false);

    await advance(30000);
    expect(surface.hidden).toBe(true);
    expect(surface.querySelector("article")).toBeNull();
  });
  it("holds the 30s refresh until the in-flight page request settles", async () => {
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
      expect(query(fetcher.mock.calls[1][0])).toMatchObject({ page: 2, q: "" });
      await advance(30000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolve(reply(page("wedding-a", 2)));
        await flush();
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(surface.textContent).toContain("Dinner 20");
    } finally {
      resolve(reply(page("wedding-a", 2)));
      await act(flush);
    }
  });
  it("renders the authorized Botanical build with enabled purchase controls and the existing selection handler", async () => {
    const env = showcaseBuildEnvironment("botanical", "production");
    vi.stubGlobal("__APP_ENV__", env.APP_ENV);
    const catalog = page(env.PUBLIC_SITE_ID);
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply({
        ...catalog,
        mode: "live",
        gifts: catalog.gifts.map((gift) => ({
          ...gift,
          pricing: { available: true, feeAllocation: "RECIPIENT_DEDUCTED" },
        })),
      }),
    );
    const { surface } = await mount(fetcher, env.PUBLIC_SITE_ID, {
      demo: true,
      liveDemoSiteId: env.PUBLIC_LIVE_DEMO_SITE_ID,
    });
    expect(surface.hidden).toBe(false);
    const purchase = [...surface.querySelectorAll("button")].find(
      (button) => button.textContent === "Escolher presente",
    );
    expect(purchase?.disabled).toBe(false);
    await click(surface, "Escolher presente");
    expect(surface.querySelector("dialog")?.open).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });
  it("renders the live production showcase without test notices and revokes it when opt-in changes", async () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply({ ...page(), mode: "live" }),
    );
    const m = await mount(fetcher, "wedding-a", {
      demo: true,
      liveDemoSiteId: "wedding-a",
    });
    expect(m.surface.hidden).toBe(false);
    expect(m.surface.textContent).toContain("Dinner 0");
    await click(m.surface, "Escolher presente");
    expect(m.surface.textContent).not.toMatch(
      /Sandbox|sem pagamentos reais|fictício|ambiente de testes/i,
    );
    await act(async () => {
      m.root.render(
        createElement(GiftRegistry, {
          siteId: "wedding-a",
          apiOrigin: "https://api.example.test",
          fetcher,
          demo: true,
          liveDemoSiteId: "wedding-b",
        }),
      );
      await flush();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(m.surface.hidden).toBe(true);
    expect(m.surface.textContent).not.toContain("Dinner 0");
    expect(m.surface.querySelector("dialog")?.open).not.toBe(true);
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
  it("does not close the selected dialog when refresh changes the catalog", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
    const { surface } = await mount(fetcher);
    await click(surface, "Escolher presente");
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
    expect(surface.textContent).not.toContain("Não inicie outro pagamento");
    expect(surface.textContent).not.toContain("Escolher presente");
    expect(
      Array.from(surface.querySelectorAll("button")).some(
        (button) => button.textContent === "Consultar pagamento",
      ),
    ).toBe(true);
    await click(surface, "Próxima página");
    expect(JSON.stringify({ ...window.sessionStorage })).toBe(snapshot);
    expect(surface.textContent).not.toContain("Não inicie outro pagamento");
    expect(
      fetcher.mock.calls.every(
        ([url, init]) =>
          !init?.method ||
          init.method === "GET" ||
          String(url).endsWith("gift-checkouts/status"),
      ),
    ).toBe(true);
  });
  const pendingCard = {
    quoteId: "quote-a",
    requestId: "request-a",
    recoveryToken: "A".repeat(43),
    method: "CREDIT_CARD",
    mode: "sandbox",
  } as const;
  const paymentStatus = (state = "CONFIRMED") => ({
    siteId: "wedding-a",
    ...pendingCard,
    recoveryToken: undefined,
    orderId: "order-a",
    attemptId: "attempt-a",
    state,
    observedAt: "2026-10-19T12:00:00.000Z",
    closedReason: state === "CLOSED_UNPAID" ? "CANCELED" : null,
    mayStartNewAttempt: state === "CLOSED_UNPAID",
    checkout: null,
  });
  function paymentFetcher(status: () => Promise<Response>) {
    return vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("gift-checkouts/status")) return status();
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
  }
  const statusCalls = (fetcher: ReturnType<typeof paymentFetcher>) =>
    fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("gift-checkouts/status"),
    );

  it.each([
    [
      "CONFIRMED",
      "Pagamento aprovado. Aguardando liberação do valor.",
      "success",
    ],
    ["RECEIVED", "Recebimento confirmado.", "success"],
  ])(
    "automatically checks the stored card and toasts authoritative %s without creating payment",
    async (state, message, kind) => {
      writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
      const notifications: unknown[] = [];
      const notify = (event: Event) =>
        notifications.push((event as CustomEvent).detail);
      window.addEventListener("entrelacos:toast", notify);
      try {
        const fetcher = paymentFetcher(async () =>
          reply({ status: paymentStatus(state) }),
        );
        const { surface } = await mount(fetcher);
        expect(statusCalls(fetcher)).toHaveLength(1);
        expect(JSON.parse(String(statusCalls(fetcher)[0][1]?.body))).toEqual({
          quoteId: pendingCard.quoteId,
          requestId: pendingCard.requestId,
          recoveryToken: pendingCard.recoveryToken,
        });
        expect(
          fetcher.mock.calls.every(
            ([url]) =>
              String(url).endsWith("gift-checkouts/status") ||
              new URL(String(url)).pathname.endsWith("/gifts"),
          ),
        ).toBe(true);
        expect(notifications).toContainEqual({ kind, message });
        expect(surface.textContent).not.toMatch(
          /Pagamento em verificação|Acompanhamento do pagamento|Ambiente de testes/,
        );
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
          await flush();
        });
        expect(statusCalls(fetcher)).toHaveLength(2);
        expect(
          notifications.filter(
            (value) => (value as { message: string }).message === message,
          ),
        ).toHaveLength(1);
      } finally {
        window.removeEventListener("entrelacos:toast", notify);
      }
    },
  );

  it("keeps uncertain payments locked and consults directly without opening a recovery modal", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const fetcher = paymentFetcher(async () =>
      reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
    );
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    await click(surface, "Consultar pagamento");
    expect(surface.querySelector("dialog")?.open).toBe(false);
    expect(statusCalls(fetcher)).toHaveLength(2);
    expect(surface.textContent).not.toContain("Escolha como presentear");
    expect(window.sessionStorage.length).toBe(1);
    for (let i = 0; i < 15; i++) await advance(3000);
    expect(statusCalls(fetcher).length).toBeLessThanOrEqual(11);
    expect(statusCalls(fetcher).length).toBeGreaterThan(1);
    expect(
      fetcher.mock.calls.every(
        ([url]) => !String(url).endsWith("gift-checkouts"),
      ),
    ).toBe(true);
  });

  it("reports a failed consultation truthfully and retries without receipt claims", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const notifications: Array<{ kind: string; message: string }> = [];
    const notify = (event: Event) =>
      notifications.push((event as CustomEvent).detail);
    window.addEventListener("entrelacos:toast", notify);
    try {
      const fetcher = paymentFetcher(async () =>
        reply({ code: "UNAVAILABLE" }, 503),
      );
      const { surface } = await mount(fetcher);
      expect(notifications).toContainEqual({
        kind: "error",
        message:
          "Não foi possível consultar o status do pagamento. Não inicie outro pagamento enquanto a verificação estiver pendente.",
      });
      expect(surface.textContent).not.toContain("Não foi possível consultar");
      await advance(3000);
      expect(notifications).toHaveLength(1);
      expect(window.sessionStorage.length).toBe(1);
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
    }
  });

  it("disposes pending status outcomes and timers on unmount", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    let resolve!: (response: Response) => void;
    const waiting = new Promise<Response>((yes) => {
      resolve = yes;
    });
    const fetcher = paymentFetcher(() => waiting);
    const notify = vi.fn();
    window.addEventListener("entrelacos:toast", notify);
    try {
      const mounted = await mount(fetcher);
      expect(statusCalls(fetcher)).toHaveLength(1);
      const marker = window.sessionStorage.getItem(
        "entrelacos:pending-gift-checkout:wedding-a",
      );
      await act(async () => {
        mounted.root.unmount();
        mounted.active = false;
        await flush();
      });
      await act(async () => {
        resolve(reply({ status: paymentStatus("RECEIVED") }));
        await flush();
      });
      await advance(60000);
      expect(statusCalls(fetcher)).toHaveLength(1);
      expect(notify).not.toHaveBeenCalled();
      expect(
        window.sessionStorage.getItem(
          "entrelacos:pending-gift-checkout:wedding-a",
        ),
      ).toBe(marker);
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
    }
  });

  it("polls a pending card until verified approval, then stops automatic checks", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    let approved = false;
    const fetcher = paymentFetcher(async () =>
      reply({
        status: paymentStatus(approved ? "CONFIRMED" : "OUTCOME_UNKNOWN"),
      }),
    );
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    approved = true;
    await advance(3000);
    expect(statusCalls(fetcher)).toHaveLength(2);
    await advance(30000);
    expect(statusCalls(fetcher)).toHaveLength(2);
    await click(surface, "Consultar pagamento");
    expect(surface.querySelector("dialog")?.open).toBe(false);
    expect(statusCalls(fetcher)).toHaveLength(3);
    expect(surface.textContent).not.toContain(
      "Pagamento aprovado. Aguardando liberação do valor.",
    );
    expect(surface.textContent).not.toContain("Recebimento confirmado");
  });

  it("toasts each explicit consultation even when approval is unchanged, without a quote or modal", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const notify = vi.fn();
    window.addEventListener("entrelacos:toast", notify);
    try {
      const fetcher = paymentFetcher(async () =>
        reply({ status: paymentStatus("CONFIRMED") }),
      );
      const { surface } = await mount(fetcher);
      expect(notify).toHaveBeenCalledTimes(1);
      await click(surface, "Consultar pagamento");
      expect(notify).toHaveBeenCalledTimes(2);
      expect((notify.mock.calls[1][0] as CustomEvent).detail).toEqual({
        kind: "success",
        message: "Pagamento aprovado. Aguardando liberação do valor.",
      });
      expect(surface.querySelector("dialog")?.open).toBe(false);
      expect(
        fetcher.mock.calls.every(
          ([url]) =>
            String(url).endsWith("gift-checkouts/status") ||
            new URL(String(url)).pathname.endsWith("/gifts"),
        ),
      ).toBe(true);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flush();
      });
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
    }
  });

  it("explains an unreadable recovery marker on direct consultation without opening a modal or creating payment", async () => {
    window.sessionStorage.setItem(
      "entrelacos:pending-gift-checkout:wedding-a",
      "broken",
    );
    const notify = vi.fn();
    window.addEventListener("entrelacos:toast", notify);
    try {
      const fetcher = paymentFetcher(async () =>
        reply({ status: paymentStatus() }),
      );
      const { surface } = await mount(fetcher);
      await click(surface, "Consultar pagamento");
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: "error",
        message:
          "Não foi possível consultar o status do pagamento. Não inicie outro pagamento enquanto a verificação estiver pendente.",
      });
      expect(surface.querySelector("dialog")?.open).toBe(false);
      expect(statusCalls(fetcher)).toHaveLength(0);
      expect(
        window.sessionStorage.getItem(
          "entrelacos:pending-gift-checkout:wedding-a",
        ),
      ).toBe("broken");
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
    }
  });

  it("offers hosted continuation as a toast action and rejects it after status or scope changes", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const notifications: Array<{
      action?: { label: string; onClick: () => void };
    }> = [];
    const notify = (event: Event) =>
      notifications.push((event as CustomEvent).detail);
    window.addEventListener("entrelacos:toast", notify);
    const navigate = vi.fn();
    const browserWindow = window;
    vi.stubGlobal(
      "window",
      new Proxy(browserWindow, {
        get(target, property) {
          if (property === "location") return { assign: navigate };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    try {
      let nextState = "AWAITING_PAYMENT";
      const fetcher = paymentFetcher(async () =>
        reply({
          status: {
            ...paymentStatus(nextState),
            checkout:
              nextState === "AWAITING_PAYMENT"
                ? {
                    quoteId: "quote-a",
                    orderId: "order-a",
                    attemptId: "attempt-a",
                    method: "CREDIT_CARD",
                    mode: "sandbox",
                    hostedUrl: "https://checkout.example.test/pay/existing",
                  }
                : null,
          },
        }),
      );
      const mounted = await mount(fetcher);
      const action = notifications[0]?.action;
      expect(action?.label).toBe("Continuar pagamento");
      action?.onClick();
      expect(navigate).toHaveBeenCalledWith(
        "https://checkout.example.test/pay/existing",
      );
      navigate.mockClear();
      nextState = "CONFIRMED";
      await click(mounted.surface, "Consultar pagamento");
      action?.onClick();
      expect(navigate).not.toHaveBeenCalled();
      nextState = "AWAITING_PAYMENT";
      await click(mounted.surface, "Consultar pagamento");
      const nextAction = notifications.at(-1)?.action;
      expect(nextAction).toBeDefined();
      await act(async () => {
        mounted.root.render(
          createElement(GiftRegistry, {
            siteId: "wedding-b",
            apiOrigin: "https://api.example.test",
            fetcher,
          }),
        );
        await flush();
      });
      nextAction?.onClick();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      browserWindow.removeEventListener("entrelacos:toast", notify);
      vi.unstubAllGlobals();
    }
  });

  it("ignores an old site's receipt after the runtime scope is replaced", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    let resolve!: (response: Response) => void;
    const waiting = new Promise<Response>((yes) => {
      resolve = yes;
    });
    const fetcher = paymentFetcher(() => waiting);
    const notify = vi.fn();
    window.addEventListener("entrelacos:toast", notify);
    try {
      const mounted = await mount(fetcher);
      const marker = window.sessionStorage.getItem(
        "entrelacos:pending-gift-checkout:wedding-a",
      );
      await act(async () => {
        mounted.root.render(
          createElement(GiftRegistry, {
            siteId: "wedding-b",
            apiOrigin: "https://api.example.test",
            fetcher,
          }),
        );
        await flush();
      });
      await act(async () => {
        resolve(reply({ status: paymentStatus("RECEIVED") }));
        await flush();
      });
      expect(notify).not.toHaveBeenCalled();
      expect(
        window.sessionStorage.getItem(
          "entrelacos:pending-gift-checkout:wedding-a",
        ),
      ).toBe(marker);
      expect(mounted.surface.textContent).not.toContain("Consultar pagamento");
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
    }
  });

  it("toasts catalog failures without embedding an error notice in the gift section", async () => {
    const notify = vi.fn();
    window.addEventListener("entrelacos:toast", notify);
    try {
      let failed = false;
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const q = query(url);
        return failed
          ? reply({ code: "UNAVAILABLE" }, 503)
          : reply(page(q.siteId, q.page, q.q));
      });
      const { surface } = await mount(fetcher);
      failed = true;
      await advance(30000);
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: "error",
        message: "Não foi possível carregar os presentes agora.",
      });
      expect(surface.querySelector('[role="alert"]')).toBeNull();
      await advance(30000);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("entrelacos:toast", notify);
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
