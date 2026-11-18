import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceivingGuide } from "./ReceivingGuide";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params: { siteId: string; page?: string };
    children: React.ReactNode;
  }) =>
    createElement(
      "a",
      {
        ...props,
        href: to
          .replace("$siteId", encodeURIComponent(params.siteId))
          .replace("$page", params.page ?? ""),
      },
      children,
    ),
}));
afterEach(() => vi.unstubAllGlobals());
function render(mode: string | null = "live") {
  return renderToStaticMarkup(
    createElement(ReceivingGuide, { siteId: "wedding-1", mode }),
  );
}
function text(html: string) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

describe("receiving guide on Pagar.me", () => {
  it("walks from the recipient data to the withdrawal in order", () => {
    const html = render();
    const steps = [
      "Envie os dados do recebedor",
      "Verifique sua identidade",
      "Aguarde a análise da Pagar.me",
      "Solicite o saque",
    ];
    const positions = steps.map((step) => html.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(
      positions.every(
        (position, index) => index === 0 || position > positions[index - 1],
      ),
    ).toBe(true);
    expect(html).toContain('href="/sites/wedding-1/receiving/details"');
    expect(html).toContain('href="/sites/wedding-1/receiving/activation"');
    expect(html).toContain('href="/sites/wedding-1/receiving/withdrawals"');
  });

  it("explains the short-lived identity link and the same-CPF bank account", () => {
    const content = text(render());
    expect(content).toContain("20 minutos");
    expect(content).toContain("conta bancária no mesmo CPF");
    expect(content).toContain("documento e uma selfie");
  });

  it("states the withdrawal fee from the tariff table and when money is available", () => {
    const content = text(render());
    expect(content).toContain("R$ 3,67");
    expect(content).toContain("Pix: assim que o pagamento é confirmado.");
    expect(content).toContain("fica disponível em cerca de 2 dias");
    expect(content).toContain("até 6x");
    expect(content).not.toMatch(/serviço Entrelaços|comiss/i);
  });

  it("names Pagar.me as the payment institution and splits responsibilities", () => {
    const html = render();
    expect(html).toContain("No EntreLaços");
    expect(html).toContain("Na Pagar.me");
    expect(html).toContain("uma empresa Stone");
    expect(html).toContain('id="receiving-guide-credit"');
  });

  it.each([
    ["development", "sandbox", true],
    ["production", "sandbox", false],
    [undefined, "sandbox", false],
    ["development", "live", false],
    ["development", null, false],
  ])(
    "shows the test-environment note only for %s / %s",
    (environment, mode, expected) => {
      vi.stubGlobal("__APP_ENV__", environment);
      expect(render(mode).includes("Ambiente de teste da Pagar.me")).toBe(
        expected,
      );
    },
  );
});
