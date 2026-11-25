import { describe, expect, it } from "vitest";
import { supportMessage, supportWhatsAppUrl } from "./supportContact";

const decodedText = (url: string) =>
  new URL(url).searchParams.get("text") ?? "";

describe("supportWhatsAppUrl", () => {
  it("opens the Entrelaços WhatsApp Business number", () => {
    const url = new URL(supportWhatsAppUrl(null));
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/5562991339861");
  });

  it("names the couple site and its address in the ready message", () => {
    const url = supportWhatsAppUrl({
      displayName: "Marina & Caio",
      publicUrl: "https://marina-e-caio.entrelacosbr.site/",
    });
    expect(decodedText(url)).toBe(
      "Olá! Sou responsável pelo site Marina & Caio (marina-e-caio.entrelacosbr.site) no Entrelaços e preciso de ajuda com os recebimentos.",
    );
    expect(url).not.toContain(" ");
  });

  it("keeps the site name when the site has no public address yet", () => {
    expect(supportMessage({ displayName: "Ana e João", publicUrl: null })).toBe(
      "Olá! Sou responsável pelo site Ana e João no Entrelaços e preciso de ajuda com os recebimentos.",
    );
  });

  it("ignores an address that is not a valid URL", () => {
    expect(
      supportMessage({ displayName: "Ana e João", publicUrl: "not a url" }),
    ).toBe(
      "Olá! Sou responsável pelo site Ana e João no Entrelaços e preciso de ajuda com os recebimentos.",
    );
  });

  it("falls back to a generic message without site context", () => {
    expect(supportMessage(null)).toBe(
      "Olá! Preciso de ajuda com os recebimentos do meu site no Entrelaços.",
    );
    expect(supportMessage({ displayName: "  ", publicUrl: null })).toBe(
      "Olá! Preciso de ajuda com os recebimentos do meu site no Entrelaços.",
    );
  });
});
