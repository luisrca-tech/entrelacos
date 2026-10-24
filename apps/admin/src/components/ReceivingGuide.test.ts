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

describe("receiving guide environment boundaries", () => {
  it("puts account access first and links the exact Entrelacos task", () => {
    const html = render();
    expect(html.indexOf("Acesse o Asaas com segurança")).toBeLessThan(
      html.indexOf("Do cadastro ao saque"),
    );
    expect(html).toContain('href="/sites/wedding-1/receiving/activation"');
    expect(html).toContain('href="/sites/wedding-1/receiving/account"');
    expect(html).toContain('href="/sites/wedding-1/receiving/withdrawals"');
    expect(html).toContain('href="https://central.ajuda.asaas.com/hc/pt-br"');
  });
  it.each([
    ["development", "sandbox", true],
    ["production", "sandbox", false],
    [undefined, "sandbox", false],
    ["development", "live", false],
    ["development", null, false],
  ])(
    "shows redirected test email only for %s / %s",
    (environment, mode, expected) => {
      vi.stubGlobal("__APP_ENV__", environment);
      expect(render(mode).includes("e-mail da conta principal")).toBe(expected);
      expect(render(mode)).not.toContain("000000");
      expect(render(mode).includes("Para testes no Sandbox")).toBe(expected);
    },
  );
  it("keeps production account guidance free of Sandbox instructions", () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const html = render("live");
    expect(html).not.toContain("Sandbox");
    expect(html).toContain("https://www.asaas.com/login/auth");
    expect(html).toContain("Asaas para Android");
    expect(html).toContain("Asaas para iPhone");
  });
  it.each([
    [
      "live",
      "https://www.asaas.com/login/auth?customerSignUpOriginChannel=HOME",
    ],
    [
      "sandbox",
      "https://sandbox.asaas.com/login/auth?customerSignUpOriginChannel=HOME",
    ],
  ])("links to the observed %s provider environment", (mode, loginUrl) => {
    const html = render(mode);
    expect(html).toContain(loginUrl);
    expect(html).not.toContain(
      mode === "live"
        ? "https://sandbox.asaas.com/login"
        : "https://www.asaas.com/login",
    );
  });
  it.each([null, "disabled", "invalid"])(
    "does not guess a login when provider mode is %s",
    (mode) => {
      const html = render(mode);
      expect(html).not.toContain("/login/auth");
      expect(html).toContain("Voltar para Recebimentos");
    },
  );
  it("explains activation, Pix destinations and optional official apps", () => {
    const html = render();
    expect(html).toContain("enviado automaticamente");
    expect(html).toContain("aprovação cadastral não confirma");
    expect(html).toContain("chave Pix de entrada");
    expect(html).toContain("não precisa ser criada no Asaas");
    expect(html).toContain("autorização manual");
    expect(html).toContain("Android");
    expect(html).toContain("iPhone");
    expect(html).toContain("id=asaas.asaas");
    expect(html).toContain("id1421133076");
    expect(html).toContain("/sites/wedding-1/receiving");
  });
  it("explains conditional integrated authorization without promising transfer completion", () => {
    const html = render();
    expect(html).toContain("consentimento e confirme sua senha do Entrelacos");
    expect(html).toContain(
      "autorização integrada de segurança estiver habilitada",
    );
    expect(html).toContain("configuração do Asaas permitir");
    expect(html).toContain(
      "o pedido pode ser autorizado pelo próprio Entrelacos",
    );
    expect(html).not.toContain("webhook");
    expect(html).toContain(
      "não estiver habilitada ou houver autorização manual",
    );
    expect(html).toContain("SMS ou Token App");
    expect(html).toContain("A autorização não confirma a conclusão do saque");
    expect(html).not.toContain("não aprova automaticamente essa autorização");
  });
});
