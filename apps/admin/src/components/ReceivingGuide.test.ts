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
    params: { siteId: string };
    children: React.ReactNode;
  }) =>
    createElement(
      "a",
      {
        ...props,
        href: to.replace("$siteId", encodeURIComponent(params.siteId)),
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
  it("explains activation, Pix destinations, manual approvals and optional official apps", () => {
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
});
