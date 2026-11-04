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
      "account",
      "fees",
      "payments",
      "withdrawals",
    ]);
  });
  it("accepts only known subpages", () => {
    for (const page of [
      "holder",
      "details",
      "activation",
      "account",
      "fees",
      "payments",
      "withdrawals",
    ])
      expect(resolveReceivingPage(page)).toBe(page);
    for (const value of [undefined, "", "overview", "../settings", "unknown"])
      expect(resolveReceivingPage(value)).toBe("overview");
  });
  it("hides payments and withdrawals until receiving is ready", () => {
    expect(receivingTabs(false)).toEqual([]);
    expect(receivingTabs(true).map(({ id }) => id)).toEqual([
      "overview",
      "payments",
      "withdrawals",
    ]);
    expect(receivingTabs(true).map(({ label }) => label)).toEqual([
      "Visão geral",
      "Pagamentos",
      "Saques",
    ]);
  });
  it("keeps overview links canonical and encodes the selected site", () => {
    expect(receivingPageHref("wedding/a", "overview")).toBe(
      "/sites/wedding%2Fa/receiving",
    );
    expect(receivingPageHref("wedding/a", "account")).toBe(
      "/sites/wedding%2Fa/receiving/account",
    );
  });
});
