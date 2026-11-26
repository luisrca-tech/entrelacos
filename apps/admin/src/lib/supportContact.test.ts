import { describe, expect, it } from "vitest";
import { supportMessage, supportWhatsAppUrl } from "./supportContact";

const decodedText = (url: string) =>
  new URL(url).searchParams.get("text") ?? "";

const activeSite = {
  displayName: "Daphnne e Samuel",
  publicUrl: "https://daphnne-e-samuel.entrelacosbr.site/",
  lifecycle: "ACTIVE",
} as const;

describe("supportWhatsAppUrl", () => {
  it("opens the Entrelaços WhatsApp Business number", () => {
    const url = new URL(supportWhatsAppUrl(null));
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/5562991339861");
  });

  it("names the active couple site and its address in the ready message", () => {
    const url = supportWhatsAppUrl(activeSite);
    expect(decodedText(url)).toBe(
      "Olá! Sou responsável pelo site Daphnne e Samuel (daphnne-e-samuel.entrelacosbr.site) no Entrelaços e preciso de ajuda com os recebimentos.",
    );
    expect(url).not.toContain(" ");
  });

  it("asks a general question when the topic is general", () => {
    expect(decodedText(supportWhatsAppUrl(activeSite, "general"))).toBe(
      "Olá! Sou responsável pelo site Daphnne e Samuel (daphnne-e-samuel.entrelacosbr.site) no Entrelaços e tenho uma dúvida.",
    );
    expect(supportMessage(null, "general")).toBe(
      "Olá! Tenho uma dúvida sobre o painel do Entrelaços.",
    );
  });

  it.each(["DRAFT", "IN_REVIEW", "INACTIVE", undefined])(
    "leaves the address out while the site is %s",
    (lifecycle) => {
      expect(supportMessage({ ...activeSite, lifecycle })).toBe(
        "Olá! Sou responsável pelo site Daphnne e Samuel no Entrelaços e preciso de ajuda com os recebimentos.",
      );
    },
  );

  it("keeps the site name when the site has no public address yet", () => {
    expect(supportMessage({ ...activeSite, publicUrl: null })).toBe(
      "Olá! Sou responsável pelo site Daphnne e Samuel no Entrelaços e preciso de ajuda com os recebimentos.",
    );
  });

  it("ignores an address that is not a valid URL", () => {
    expect(supportMessage({ ...activeSite, publicUrl: "not a url" })).toBe(
      "Olá! Sou responsável pelo site Daphnne e Samuel no Entrelaços e preciso de ajuda com os recebimentos.",
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
