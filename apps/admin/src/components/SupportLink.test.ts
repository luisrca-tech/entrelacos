import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { supportWhatsAppUrl } from "../lib/supportContact";
import { SupportLink, SupportSiteProvider } from "./SupportLink";

const site = {
  displayName: "Marina e Caio",
  publicUrl: "https://marina-e-caio.entrelacosbr.site",
};

describe("SupportLink", () => {
  it("sends the current site to WhatsApp support in a new tab", () => {
    const html = renderToStaticMarkup(
      createElement(SupportSiteProvider, { site }, createElement(SupportLink)),
    );
    expect(html).toContain(`href="${supportWhatsAppUrl(site)}"`);
    expect(html).toContain("marina-e-caio.entrelacosbr.site");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Falar com o suporte do EntreLaços");
  });

  it("uses the generic message outside a site workspace", () => {
    const html = renderToStaticMarkup(createElement(SupportLink));
    expect(html).toContain(`href="${supportWhatsAppUrl(null)}"`);
  });
});
