import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  receivingPageHref,
  receivingPages,
  receivingTabs,
  resolveReceivingPage,
} from "./receivingNavigation";

describe("receiving navigation", () => {
  it("exposes one focused page for each receiving task", () => {
    expect(receivingPages.map(({ id }) => id)).toEqual([
      "overview",
      "holder",
      "details",
      "activation",
      "fees",
      "payments",
      "withdrawals",
      "settings",
    ]);
  });
  it("accepts only known subpages", () => {
    for (const page of [
      "holder",
      "details",
      "activation",
      "fees",
      "payments",
      "withdrawals",
      "settings",
    ])
      expect(resolveReceivingPage(page)).toBe(page);
    for (const value of [undefined, "", "overview", "../settings", "unknown"])
      expect(resolveReceivingPage(value)).toBe("overview");
  });
  it("hides the ready tabs until receiving is ready", () => {
    expect(receivingTabs(false)).toEqual([]);
    expect(receivingTabs(true).map(({ id }) => id)).toEqual([
      "overview",
      "payments",
      "withdrawals",
      "settings",
    ]);
    expect(receivingTabs(true).map(({ label }) => label)).toEqual([
      "Visão geral",
      "Pagamentos",
      "Saques",
      "Configurações",
    ]);
  });
  it("keeps overview links canonical and encodes the selected site", () => {
    expect(receivingPageHref("wedding/a", "overview")).toBe(
      "/sites/wedding%2Fa/receiving",
    );
    expect(receivingPageHref("wedding/a", "activation")).toBe(
      "/sites/wedding%2Fa/receiving/activation",
    );
  });
  it("drops the retired Pix destination page and its screens", () => {
    expect(resolveReceivingPage("account")).toBe("overview");
    expect(receivingPages.find(({ id }) => id === "activation")?.label).toBe(
      "Status da conta",
    );
    for (const file of [
      "ReceivingPixDestination.tsx",
      "ReceivingPixDestination.test.ts",
      "savedPixDestination.ts",
      "savedPixDestination.test.ts",
    ])
      expect(existsSync(new URL(`./${file}`, import.meta.url))).toBe(false);
  });
});
