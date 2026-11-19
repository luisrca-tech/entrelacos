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
    vi.unstubAllEnvs();
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
  async function refocus() {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
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
  it("keeps the rendered cards during a slow or failed refresh on focus", async () => {
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

    await advance(10 * 60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    await refocus();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(surface.querySelector("article")).toBe(card);
    expect(surface.textContent).not.toContain("Carregando presentes");

    await act(async () => {
      resolve(reply({}, 503));
      await flush();
    });
    expect(surface.querySelector("article")).toBe(card);
    expect(surface.hidden).toBe(false);

    await refocus();
    expect(surface.hidden).toBe(true);
    expect(surface.querySelector("article")).toBeNull();
  });
  it("skips a focus refresh while a page request is in flight", async () => {
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
      await refocus();
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
    await refocus();
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
    // A legacy attempt without a gift binding stays reachable discreetly.
    expect(
      surface.querySelector("[data-gift-payment-fallback] button")?.textContent,
    ).toBe("Ver pagamento");
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
    giftId: "gift-1",
  } as const;
  const paymentStatus = (state = "RECEIVED") => ({
    siteId: "wedding-a",
    ...pendingCard,
    recoveryToken: undefined,
    giftId: undefined,
    checkoutId: "checkout-a",
    state,
    observedAt: "2026-10-19T12:00:00.000Z",
    closedReason: state === "CLOSED_UNPAID" ? "FAILED" : null,
    mayStartNewAttempt: state === "CLOSED_UNPAID",
    pix: null,
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
  const pendingKey = "entrelacos:pending-gift-checkout:wedding-a";
  const toastLog: Array<{ kind: string; message: string }> = [];
  const recordToast = (event: Event) =>
    toastLog.push(
      (event as CustomEvent<{ kind: string; message: string }>).detail,
    );
  beforeEach(() => {
    toastLog.length = 0;
    window.addEventListener("entrelacos:toast", recordToast);
  });
  afterEach(() => window.removeEventListener("entrelacos:toast", recordToast));
  const paymentDialog = (surface: HTMLElement) =>
    surface.querySelector<HTMLDialogElement>(
      'dialog[aria-labelledby="gift-payment-heading"]',
    );
  const cardActions = (surface: HTMLElement) =>
    Array.from(surface.querySelectorAll("article"), (card) =>
      Array.from(card.querySelectorAll("button"), (b) => b.textContent).join(
        "|",
      ),
    );
  async function openPayment(surface: HTMLElement) {
    const badge = Array.from(surface.querySelectorAll("button")).find(
      (b) => b.textContent === "Ver pagamento",
    );
    if (!badge) throw new Error("Missing payment badge");
    await act(async () => {
      badge.focus();
      badge.click();
      await flush();
    });
    return badge;
  }

  describe("with money gifts switched off", () => {
    beforeEach(() => vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false"));

    it("keeps the gifts listed with a disabled button that opens nothing", async () => {
      const fetcher = paymentFetcher(async () =>
        reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
      );
      const { surface } = await mount(fetcher);
      expect(surface.hidden).toBe(false);
      expect(surface.querySelectorAll("article")).toHaveLength(20);
      expect(surface.textContent).toContain("Dinner 0");
      const purchase =
        surface.querySelector<HTMLButtonElement>("article button");
      expect(purchase?.textContent).toBe("Escolher presente");
      expect(purchase?.disabled).toBe(true);
      expect(purchase?.getAttribute("aria-disabled")).toBe("true");
      const notice = document.getElementById(
        purchase?.getAttribute("aria-describedby") ?? "",
      );
      expect(notice?.textContent).toBe(
        "Os presentes em dinheiro estarão disponíveis em breve.",
      );
      await act(async () => {
        purchase?.click();
        await flush();
      });
      expect(surface.querySelector("dialog")?.open).not.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    });

    it("never resumes a saved checkout attempt", async () => {
      writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
      const fetcher = paymentFetcher(async () =>
        reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
      );
      const { surface } = await mount(fetcher);
      await advance(60_000);
      expect(statusCalls(fetcher)).toHaveLength(0);
      expect(surface.textContent).not.toContain("Ver pagamento");
      expect(surface.querySelector("[data-gift-payment-fallback]")).toBeNull();
      expect(window.sessionStorage.getItem(pendingKey)).not.toBeNull();
    });
  });

  it("marks only the gift with a saved attempt instead of a block above the list", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const fetcher = paymentFetcher(async () =>
      reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
    );
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    expect(
      surface.querySelector('[aria-label="Acompanhamento do pagamento"]'),
    ).toBeNull();
    expect(surface.textContent).not.toMatch(
      /Pagamento em verificação|Consultar pagamento/,
    );
    expect(surface.querySelector("[data-gift-payment-fallback]")).toBeNull();
    const actions = cardActions(surface);
    expect(actions[1]).toBe("Ver pagamento");
    expect(actions.filter((action) => action !== "")).toEqual([
      "Ver pagamento",
    ]);
    expect(
      surface
        .querySelectorAll("article")[1]
        .querySelector("button")
        ?.getAttribute("aria-haspopup"),
    ).toBe("dialog");
  });

  it("opens an accessible payment modal that polls with backoff only while open", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const fetcher = paymentFetcher(async () =>
      reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
    );
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    await advance(600000);
    expect(statusCalls(fetcher)).toHaveLength(1);

    const badge = await openPayment(surface);
    const dialog = paymentDialog(surface);
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById("gift-payment-heading")?.textContent).toBe(
      "Acompanhar pagamento",
    );
    expect(dialog?.textContent).toContain("Dinner 1");
    expect(dialog?.querySelector('[role="status"]')?.textContent).toBe(
      "Pagamento em verificação",
    );
    expect(dialog?.textContent).toContain("Consultar pagamento");
    expect(dialog?.textContent).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
    expect(dialog?.querySelector("a, summary, img")).toBeNull();
    expect(statusCalls(fetcher)).toHaveLength(2);

    for (const [wait, total] of [
      [2999, 2],
      [1, 3],
      [6000, 4],
      [12000, 5],
      [24000, 6],
      [48000, 7],
      [60000, 8],
    ])
      await advance(wait).then(() =>
        expect(statusCalls(fetcher)).toHaveLength(total),
      );
    for (let i = 0; i < 20; i++) await advance(60000);
    expect(statusCalls(fetcher)).toHaveLength(11);

    await act(async () => {
      dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
      await flush();
    });
    expect(dialog?.open).toBe(false);
    expect(document.activeElement).toBe(badge);
    expect(window.sessionStorage.getItem(pendingKey)).not.toBeNull();

    await openPayment(surface);
    expect(statusCalls(fetcher)).toHaveLength(12);
    await act(async () => {
      paymentDialog(surface)?.dispatchEvent(
        new Event("cancel", { cancelable: true }),
      );
      await flush();
    });
    for (let i = 0; i < 10; i++) await advance(60000);
    expect(statusCalls(fetcher)).toHaveLength(12);
  });

  it("stops polling, clears the attempt and thanks the guest once the payment is confirmed", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    let approved = false;
    const fetcher = paymentFetcher(async () =>
      reply({
        status: paymentStatus(approved ? "RECEIVED" : "OUTCOME_UNKNOWN"),
      }),
    );
    const { surface } = await mount(fetcher);
    await openPayment(surface);
    expect(statusCalls(fetcher)).toHaveLength(2);
    approved = true;
    await advance(3000);
    expect(statusCalls(fetcher)).toHaveLength(3);
    expect(paymentDialog(surface)?.open).toBe(false);
    expect(toastLog).toEqual([
      {
        kind: "success",
        message: "Pagamento confirmado. Obrigado pelo presente!",
      },
    ]);
    expect(window.sessionStorage.getItem(pendingKey)).toBeNull();
    expect(cardActions(surface)[1]).toBe("Escolher presente");
    for (let i = 0; i < 10; i++) await advance(60000);
    await refocus();
    expect(statusCalls(fetcher)).toHaveLength(3);
    expect(toastLog).toHaveLength(1);
  });

  it.each(["RECEIVED"])(
    "settles a %s attempt found on return without showing a payment block",
    async (state) => {
      writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
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
      expect(toastLog).toEqual([
        {
          kind: "success",
          message: "Pagamento confirmado. Obrigado pelo presente!",
        },
      ]);
      expect(window.sessionStorage.getItem(pendingKey)).toBeNull();
      expect(surface.textContent).not.toMatch(
        /Ver pagamento|Recebimento confirmado|Pagamento aprovado/,
      );
      expect(cardActions(surface).every((a) => a === "Escolher presente")).toBe(
        true,
      );
      await refocus();
      expect(statusCalls(fetcher)).toHaveLength(1);
    },
  );

  it("clears a closed unpaid attempt so its badge does not come back", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const fetcher = paymentFetcher(async () =>
      reply({ status: paymentStatus("CLOSED_UNPAID") }),
    );
    const first = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    expect(window.sessionStorage.getItem(pendingKey)).toBeNull();
    expect(toastLog).toEqual([
      {
        kind: "warning",
        message: "O pagamento não foi concluído. Você pode tentar novamente.",
      },
    ]);
    expect(first.surface.textContent).not.toMatch(
      /Ver pagamento|Pagamento encerrado/,
    );
    expect(cardActions(first.surface)[1]).toBe("Escolher presente");
    await act(async () => {
      first.root.unmount();
      first.active = false;
    });
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    expect(surface.textContent).not.toContain("Ver pagamento");
  });

  it("keeps a failed consultation inside the modal and retries only the existing attempt", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    let unavailable = true;
    const fetcher = paymentFetcher(async () =>
      unavailable
        ? reply({ code: "UNAVAILABLE" }, 503)
        : reply({ status: paymentStatus("OUTCOME_UNKNOWN") }),
    );
    const { surface } = await mount(fetcher);
    expect(statusCalls(fetcher)).toHaveLength(1);
    await openPayment(surface);
    const dialog = paymentDialog(surface);
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
      "Não foi possível consultar o pagamento agora.",
    );
    unavailable = false;
    await click(surface, "Consultar pagamento");
    expect(dialog?.querySelector('[role="status"]')?.textContent).toBe(
      "Pagamento em verificação",
    );
    expect(statusCalls(fetcher)).toHaveLength(3);
    expect(
      statusCalls(fetcher).every(
        ([, init]) =>
          JSON.parse(String(init?.body)).requestId === pendingCard.requestId,
      ),
    ).toBe(true);
    expect(toastLog).toEqual([]);
  });

  it("shows a slow consultation in the modal even before the catalog arrives", async () => {
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingCard);
    const fetcher = vi.fn<typeof fetch>((url) =>
      String(url).endsWith("gift-checkouts/status")
        ? new Promise<Response>(() => {})
        : new Promise<Response>(() => {}),
    );
    const { surface } = await mount(fetcher);
    expect(surface.hidden).toBe(false);
    expect(surface.textContent).not.toContain("Consultando pagamento…");
    await openPayment(surface);
    expect(
      paymentDialog(surface)?.querySelector('[role="status"]')?.textContent,
    ).toBe("Consultando pagamento…");
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

  it("shows an unavailable consultation when the saved attempt is unreadable", async () => {
    window.sessionStorage.setItem(pendingKey, "broken");
    const fetcher = paymentFetcher(async () =>
      reply({ status: paymentStatus() }),
    );
    const { surface } = await mount(fetcher);
    expect(surface.textContent).not.toContain("Escolher presente");
    await openPayment(surface);
    const dialog = paymentDialog(surface);
    expect(dialog?.textContent).toContain(
      "Não foi possível consultar o pagamento agora.",
    );
    expect(dialog?.textContent).not.toContain("Consultar pagamento");
    expect(surface.querySelectorAll("dialog")[0]?.open).toBe(false);
    expect(statusCalls(fetcher)).toHaveLength(0);
    expect(window.sessionStorage.getItem(pendingKey)).toBe("broken");
  });

  it("shows the open Pix only while the payment is awaiting completion", async () => {
    const pendingPix = { ...pendingCard, method: "PIX" } as const;
    writePendingGiftCheckout(window.sessionStorage, "wedding-a", pendingPix);
    const pix = {
      qrCode: "00020126580014br.gov.bcb.pix0136checkout-a",
      qrCodeUrl: "https://pix.example.test/checkout-a.png",
      expiresAt: "2099-10-19T12:30:00.000Z",
    };
    let nextState = "AWAITING_PAYMENT";
    const fetcher = paymentFetcher(async () =>
      reply({
        status: {
          ...paymentStatus(nextState),
          method: "PIX",
          pix: nextState === "AWAITING_PAYMENT" ? pix : null,
        },
      }),
    );
    const { surface } = await mount(fetcher);
    expect(surface.textContent).not.toContain("Pix copia e cola");
    await openPayment(surface);
    const dialog = paymentDialog(surface);
    expect(document.getElementById("gift-payment-heading")?.textContent).toBe(
      "Pagar com Pix",
    );
    expect(dialog?.querySelector('[role="status"]')?.textContent).toBe(
      "Aguardando o Pix",
    );
    expect(dialog?.textContent).toContain("Pix copia e cola");
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      pix.qrCodeUrl,
    );
    expect(dialog?.querySelector("a")).toBeNull();
    nextState = "RECEIVED";
    await click(surface, "Já paguei");
    expect(paymentDialog(surface)?.open).toBe(false);
    expect(surface.textContent).not.toContain("Pix copia e cola");
    expect(toastLog.map((t) => t.message)).toEqual([
      "Pagamento confirmado. Obrigado pelo presente!",
    ]);
    expect(window.sessionStorage.getItem(pendingKey)).toBeNull();
  });

  const checkoutQuote = (giftId: string, method: string) => ({
    id: "quote-new",
    giftId,
    siteId: "wedding-a",
    title: "Dinner 0",
    method,
    currency: "BRL",
    nominalCents: 10000,
    commissionBasisPoints: 200,
    commissionCents: 200,
    processingCents: 150,
    totalCents: 10350,
    policyVersion: "test-v1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    mode: "sandbox",
  });
  function checkoutFetcher(create: () => Response) {
    return vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/gift-quotes")) {
        const body = JSON.parse(String(init?.body));
        return reply({ quote: checkoutQuote(body.giftId, body.method) });
      }
      if (path.endsWith("/gift-checkouts")) return create();
      if (path.endsWith("/gift-checkouts/status"))
        return reply({ status: paymentStatus("OUTCOME_UNKNOWN") });
      const q = query(url);
      return reply(page(q.siteId, q.page, q.q));
    });
  }
  async function type(surface: HTMLElement, label: string, value: string) {
    const input = Array.from(surface.querySelectorAll("label"))
      .find((element) => element.textContent?.trim().startsWith(label))
      ?.querySelector("input");
    if (!input) throw new Error(`Missing field ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function payWithPix(surface: HTMLElement) {
    await click(surface, "Escolher presente");
    await click(surface, "Pix");
    await type(surface, "Nome completo", "Ana Souza");
    await type(surface, "CPF", "529.982.247-25");
    await type(surface, "E-mail", "ana@example.com");
    await type(surface, "Celular", "11 98765-4321");
    await click(surface, "Gerar Pix");
  }

  it.each([
    [
      "PIX_UNAVAILABLE",
      "Não foi possível abrir o Pix. Tente novamente ou use cartão.",
    ],
    [
      "PAYMENT_METHOD_UNAVAILABLE",
      "Não foi possível abrir o pagamento. Tente novamente ou escolha outra forma.",
    ],
  ])(
    "returns the gift to normal after a definitive %s rejection",
    async (code, message) => {
      const fetcher = checkoutFetcher(() =>
        reply(
          {
            type: "about:blank",
            status: 422,
            code,
            title: "Gift payment request rejected",
          },
          422,
        ),
      );
      const { surface } = await mount(fetcher);
      await payWithPix(surface);
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).endsWith("/gift-checkouts"),
        ),
      ).toHaveLength(1);
      expect(toastLog).toEqual([{ kind: "error", message }]);
      expect(window.sessionStorage.getItem(pendingKey)).toBeNull();
      expect(surface.querySelector("dialog")?.open).toBe(false);
      expect(surface.textContent).not.toMatch(
        /verificação|Ver pagamento|Aguarde…/,
      );
      expect(cardActions(surface).every((a) => a === "Escolher presente")).toBe(
        true,
      );
      expect(
        Array.from(surface.querySelectorAll("article button")).some(
          (button) => (button as HTMLButtonElement).disabled,
        ),
      ).toBe(false);
      expect(
        fetcher.mock.calls.some(([url]) =>
          String(url).endsWith("gift-checkouts/status"),
        ),
      ).toBe(false);
      await click(surface, "Escolher presente");
      expect(surface.querySelector("dialog")?.open).toBe(true);
      await click(surface, "Cartão de crédito");
      expect(
        surface.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
          ?.textContent,
      ).toBe("Cartão de crédito");
    },
  );

  it("moves an unknown checkout outcome to a discreet badge on the chosen gift", async () => {
    const fetcher = checkoutFetcher(() =>
      reply({ code: "EXTERNAL_OUTCOME_UNKNOWN" }, 409),
    );
    const { surface } = await mount(fetcher);
    await payWithPix(surface);
    expect(surface.querySelector("dialog")?.open).toBe(false);
    expect(
      JSON.parse(window.sessionStorage.getItem(pendingKey) ?? "null")?.giftId,
    ).toBe("gift-0");
    expect(cardActions(surface)[0]).toBe("Ver pagamento");
    expect(toastLog).toEqual([
      {
        kind: "warning",
        message:
          "Pagamento em verificação. Acompanhe pelo botão “Ver pagamento”.",
      },
    ]);
    expect(statusCalls(fetcher)).toHaveLength(1);
    for (let i = 0; i < 10; i++) await advance(60000);
    expect(statusCalls(fetcher)).toHaveLength(1);
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
      expect(mounted.surface.textContent).not.toMatch(
        /Consultar pagamento|Recebimento confirmado/,
      );
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
      await refocus();
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: "error",
        message: "Não foi possível carregar os presentes agora.",
      });
      expect(surface.querySelector('[role="alert"]')).toBeNull();
      await refocus();
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
