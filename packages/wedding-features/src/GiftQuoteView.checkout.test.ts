// @vitest-environment jsdom
import {
  allocateGiftInstallmentCents,
  type GiftQuote,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftQuoteView } from "./GiftQuoteView";

const now = new Date("2026-10-12T12:00:00.000Z");
const totals = [10_521, 10_870, 11_010, 11_150, 11_300, 11_450, 11_600];
const options = totals.map((totalCents, index) => ({
  installmentCount: index + 1,
  totalCents,
  installmentSurchargeCents: totalCents - totals[0],
  installmentCents: allocateGiftInstallmentCents(totalCents, index + 1),
}));
const cardQuote: GiftQuote = {
  id: "quote-card",
  giftId: "gift-1",
  siteId: "site-1",
  title: "Jantar especial",
  method: "CREDIT_CARD",
  currency: "BRL",
  nominalCents: 10_000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 321,
  totalCents: 10_521,
  feeAllocation: "BUYER_GROSS_UP",
  settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
  policyVersion: "policy-1",
  expiresAt: "2026-10-12T15:30:00.000Z",
  mode: "sandbox",
  installmentCount: 1,
  installmentCents: [10_521],
  installmentSurchargeCents: 0,
  installmentOptions: options,
};
const pixQuote: GiftQuote = {
  ...cardQuote,
  id: "quote-pix",
  method: "PIX",
  installmentCount: undefined,
  installmentCents: undefined,
  installmentSurchargeCents: undefined,
  installmentOptions: undefined,
};

let root: Root;
let container: HTMLElement;
let fetchStub: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__APP_ENV__", "development");
  // No test reaches ViaCEP: by default every CEP is unknown.
  fetchStub = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ erro: "true" })),
  );
  vi.stubGlobal("fetch", fetchStub);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<Parameters<typeof GiftQuoteView>[0]> = {}) {
  const onConfirm = vi.fn();
  act(() =>
    root.render(
      createElement(GiftQuoteView, {
        quote: cardQuote,
        method: "CREDIT_CARD",
        installmentCount: 1,
        loading: false,
        pending: false,
        onSelectMethod: vi.fn(),
        onConfirm,
        onCancel: vi.fn(),
        now,
        ...props,
      }),
    ),
  );
  return onConfirm;
}

function field(label: string): HTMLInputElement {
  const match = [...container.querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === label,
  );
  const input = match?.querySelector("input");
  if (!input) throw new Error(`Missing field ${label}`);
  return input;
}

const paulista = {
  logradouro: "Avenida Paulista",
  bairro: "Bela Vista",
  localidade: "São Paulo",
  uf: "SP",
};

/** A ViaCEP answer the test releases by hand, to act while it is pending. */
function deferredFetch() {
  let release: (body: unknown) => void = () => {};
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        release = (body) => resolve(new Response(JSON.stringify(body)));
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, release: (body: unknown) => release(body) };
}

function stateSelect() {
  const select = container.querySelector<HTMLSelectElement>(
    'select[name="billing-state"]',
  );
  if (!select) throw new Error("Missing UF select");
  return select;
}

function type(label: string, value: string) {
  const input = field(label);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(label: string, value: string) {
  const select = [...container.querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === label,
  )?.control;
  if (!(select instanceof HTMLSelectElement))
    throw new Error(`Missing select ${label}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function fillCard() {
  type("Número do cartão", "4000 0000 0000 0010");
  type("Nome impresso no cartão", "ANA SOUZA");
  type("Validade", "12/30");
  type("CVV", "123");
}

function fillBilling() {
  type("CEP", "01310-100");
  type("Rua", " Avenida  Paulista ");
  type("Número", "1000");
  type("Bairro", "Bela Vista");
  type("Cidade", "São Paulo");
  choose("UF", "SP");
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fillBuyer() {
  type("Nome completo", "  Ana Souza ");
  type("CPF", "529.982.247-25");
  type("E-mail", "ana@example.com");
  type("Celular", "(11) 98765-4321");
}

function submit() {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("type") === "submit",
  );
  if (!button) throw new Error("Missing submit button");
  act(() => button.click());
}

describe("transparent card checkout form", () => {
  it("offers 1x to 6x with the installment value and total from the quote", () => {
    render();
    const labels = [
      ...container.querySelectorAll(
        'select:not([name="billing-state"]) option',
      ),
    ].map((option) => option.textContent ?? "");
    expect(labels).toHaveLength(6);
    expect(labels[0]).toMatch(/^1x à vista · R\$\s*105,21$/);
    expect(labels[2]).toMatch(/^3x de R\$\s*36,70 · total R\$\s*110,10$/);
    expect(labels[5]).toMatch(/^6x de R\$\s*19,08 · total R\$\s*114,50$/);
    expect(labels.join(" ")).not.toContain("7x");
  });

  it("collects the card and the buyer and hands them over only on submit", () => {
    const onConfirm = render();
    for (const label of [
      "Número do cartão",
      "Nome impresso no cartão",
      "Validade",
      "CVV",
      "Nome completo",
      "CPF",
      "E-mail",
      "Celular",
    ])
      expect(field(label)).toBeTruthy();
    expect(field("Número do cartão").getAttribute("autocomplete")).toBe(
      "cc-number",
    );
    expect(field("CVV").getAttribute("autocomplete")).toBe("cc-csc");
    // Card inputs carry no name, so no form serialization can pick them up.
    for (const label of ["Número do cartão", "Validade", "CVV"])
      expect(field(label).hasAttribute("name")).toBe(false);
    fillBuyer();
    fillCard();
    fillBilling();
    type("Complemento (opcional)", "Apto 12");
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      buyer: {
        name: "Ana Souza",
        cpf: "52998224725",
        email: "ana@example.com",
        phone: "11987654321",
      },
      card: {
        number: "4000000000000010",
        holderName: "ANA SOUZA",
        expMonth: 12,
        expYear: 2030,
        cvv: "123",
      },
      billingAddress: {
        zipCode: "01310100",
        street: "Avenida Paulista",
        streetNumber: "1000",
        complement: "Apto 12",
        neighborhood: "Bela Vista",
        city: "São Paulo",
        state: "SP",
      },
    });
    expect(container.textContent).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
  });

  it("asks for the card billing address and keeps an incomplete one in the form", () => {
    const onConfirm = render();
    expect(field("CEP").getAttribute("autocomplete")).toBe(
      "billing postal-code",
    );
    expect(field("CEP").getAttribute("inputmode")).toBe("numeric");
    fillBuyer();
    fillCard();
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "CEP",
    );
    fillBilling();
    type("Número", " ");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "número",
    );
    type("Número", "1000");
    choose("UF", "");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "UF",
    );
  });

  it("fills the address from the CEP and lets the guest type it when ViaCEP fails", async () => {
    const fetch = fetchStub.mockImplementation(async (input) =>
      String(input).includes("01310100")
        ? new Response(JSON.stringify(paulista))
        : new Response(JSON.stringify({ erro: "true" })),
    );
    render();
    type("CEP", "01310-100");
    await flush();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://viacep.com.br/ws/01310100/json/",
    );
    expect(field("Rua").value).toBe("Avenida Paulista");
    expect(field("Bairro").value).toBe("Bela Vista");
    expect(field("Cidade").value).toBe("São Paulo");
    expect(
      container.querySelector<HTMLSelectElement>('select[name="billing-state"]')
        ?.value,
    ).toBe("SP");
    expect(field("Número").value).toBe("");
    type("CEP", "99999-999");
    await flush();
    expect(container.textContent).toContain(
      "Não encontramos este CEP. Preencha o endereço.",
    );
    expect(field("Rua").disabled).toBe(false);
  });

  it("tells the guest when ViaCEP is unavailable instead of blaming the CEP", async () => {
    fetchStub.mockImplementation(async () => {
      throw new TypeError("offline");
    });
    render();
    type("CEP", "01310-100");
    await flush();
    expect(container.textContent).toContain(
      "Não foi possível buscar o endereço agora. Preencha manualmente.",
    );
    expect(container.textContent).not.toContain("Não encontramos este CEP");
    fetchStub.mockImplementation(
      async () => new Response("busy", { status: 429 }),
    );
    type("CEP", "04538-133");
    await flush();
    expect(container.textContent).toContain(
      "Não foi possível buscar o endereço agora. Preencha manualmente.",
    );
  });

  it("keeps what the guest typed while the CEP lookup was running", async () => {
    const viaCep = deferredFetch();
    render();
    type("CEP", "01310-100");
    expect(container.textContent).toContain("Buscando o endereço…");
    type("Rua", "Rua Digitada");
    type("Cidade", "Santo André");
    await act(async () => viaCep.release(paulista));
    await flush();
    expect(field("Rua").value).toBe("Rua Digitada");
    expect(field("Cidade").value).toBe("Santo André");
    expect(field("Bairro").value).toBe("Bela Vista");
    expect(stateSelect().value).toBe("SP");
  });

  it("fills again from a new CEP the fields not edited since that lookup", async () => {
    render();
    fetchStub.mockImplementation(
      async () => new Response(JSON.stringify(paulista)),
    );
    type("Rua", "Rua Antiga");
    type("CEP", "01310-100");
    await flush();
    expect(field("Rua").value).toBe("Avenida Paulista");
    fetchStub.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            logradouro: "Avenida Faria Lima",
            bairro: "Itaim Bibi",
            localidade: "São Paulo",
            uf: "SP",
          }),
        ),
    );
    type("CEP", "04538-133");
    await flush();
    expect(field("Rua").value).toBe("Avenida Faria Lima");
    expect(field("Bairro").value).toBe("Itaim Bibi");
  });

  it("aborts the lookup when the CEP changes or the form closes", async () => {
    const viaCep = deferredFetch();
    render();
    type("CEP", "01310-100");
    const first = viaCep.fetch.mock.calls[0]?.[1]?.signal;
    expect(first?.aborted).toBe(false);
    type("CEP", "01310-10");
    expect(first?.aborted).toBe(true);
    expect(container.textContent).not.toContain("Buscando o endereço…");
    type("CEP", "01310-100");
    const second = viaCep.fetch.mock.calls[1]?.[1]?.signal;
    act(() => root.render(null));
    expect(second?.aborted).toBe(true);
  });

  it("accepts a pasted CEP with a dot and looks it up", async () => {
    render();
    expect(field("CEP").hasAttribute("maxlength")).toBe(false);
    type("CEP", "01.310-100");
    expect(field("CEP").value).toBe("01310-100");
    await flush();
    expect(String(fetchStub.mock.calls[0]?.[0])).toBe(
      "https://viacep.com.br/ws/01310100/json/",
    );
    type("CEP", "01310-1009999");
    expect(field("CEP").value).toBe("01310-100");
  });

  it("says the CEP goes to ViaCEP and lets the number take letters", () => {
    render();
    const fieldset = [...container.querySelectorAll("fieldset")].find(
      (element) =>
        element.querySelector("legend")?.textContent === "Endereço de cobrança",
    );
    expect(fieldset?.textContent).toContain("ViaCEP");
    expect(fieldset?.textContent).not.toContain("só para a Pagar.me");
    expect(field("Número").hasAttribute("inputmode")).toBe(false);
    expect(field("Complemento (opcional)").hasAttribute("required")).toBe(
      false,
    );
  });

  it("clears the invalid mark of the fields ViaCEP fills", async () => {
    fetchStub.mockImplementation(
      async () => new Response(JSON.stringify(paulista)),
    );
    render();
    fillBuyer();
    fillCard();
    submit();
    expect(document.activeElement).toBe(field("CEP"));
    expect(field("Rua").getAttribute("aria-invalid")).toBe("true");
    type("CEP", "01310-100");
    await flush();
    expect(field("CEP").hasAttribute("aria-invalid")).toBe(false);
    for (const label of ["Rua", "Bairro", "Cidade"])
      expect(field(label).hasAttribute("aria-invalid")).toBe(false);
    expect(stateSelect().hasAttribute("aria-invalid")).toBe(false);
    expect(field("Número").getAttribute("aria-invalid")).toBe("true");
  });

  it("marks the invalid billing fields and focuses the first one", () => {
    const onConfirm = render();
    fillBuyer();
    fillCard();
    type("CEP", "01310-100");
    type("Rua", "Avenida Paulista");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("Número"));
    expect(field("Número").getAttribute("aria-invalid")).toBe("true");
    expect(field("Bairro").getAttribute("aria-invalid")).toBe("true");
    expect(field("Cidade").getAttribute("aria-invalid")).toBe("true");
    expect(stateSelect().getAttribute("aria-invalid")).toBe("true");
    expect(field("CEP").hasAttribute("aria-invalid")).toBe(false);
    expect(field("Rua").hasAttribute("aria-invalid")).toBe(false);
    type("Número", "1000");
    expect(field("Número").hasAttribute("aria-invalid")).toBe(false);
    expect(field("Bairro").getAttribute("aria-invalid")).toBe("true");
    type("Bairro", "Bela Vista");
    type("Cidade", "São Paulo");
    choose("UF", "SP");
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it("keeps invalid buyer or card data in the form", () => {
    const onConfirm = render();
    fillBuyer();
    type("CPF", "111.111.111-11");
    fillCard();
    fillBilling();
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "CPF",
    );
    type("CPF", "529.982.247-25");
    type("Validade", "13/30");
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "validade",
    );
  });
});

describe("Pix checkout form", () => {
  it("drops a typed billing address when the guest switches from card to Pix", () => {
    render();
    fillBuyer();
    fillCard();
    fillBilling();
    const onConfirm = render({ quote: pixQuote, method: "PIX" });
    expect(() => field("CEP")).toThrow();
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toEqual({
      buyer: {
        name: "Ana Souza",
        cpf: "52998224725",
        email: "ana@example.com",
        phone: "11987654321",
      },
    });
  });

  it("asks only for the buyer and generates the Pix", () => {
    const onConfirm = render({ quote: pixQuote, method: "PIX" });
    expect(() => field("Número do cartão")).toThrow();
    expect(() => field("CEP")).toThrow();
    expect(container.textContent).not.toContain("Endereço de cobrança");
    expect(container.querySelector("select")).toBeNull();
    fillBuyer();
    submit();
    expect(onConfirm).toHaveBeenCalledWith({
      buyer: {
        name: "Ana Souza",
        cpf: "52998224725",
        email: "ana@example.com",
        phone: "11987654321",
      },
    });
    expect(container.textContent).toContain("Gerar Pix");
  });
});
