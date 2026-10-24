import { describe, expect, it } from "vitest";
import {
  receivingPageHref,
  receivingPages,
  resolveReceivingPage,
} from "./receivingNavigation";

describe("receiving navigation", () => {
  it("exposes one focused page for each receiving task", () => {
    expect(receivingPages.map(({ id }) => id)).toEqual([
      "overview",
      "activation",
      "account",
      "payments",
      "withdrawals",
    ]);
    expect(receivingPages.map(({ label }) => label)).toEqual([
      "Visão geral",
      "Ativação",
      "Conta para saque",
      "Pagamentos",
      "Saques",
    ]);
  });
  it("accepts only known subpages", () => {
    expect(resolveReceivingPage("activation")).toBe("activation");
    expect(resolveReceivingPage("account")).toBe("account");
    expect(resolveReceivingPage("payments")).toBe("payments");
    expect(resolveReceivingPage("withdrawals")).toBe("withdrawals");
    for (const value of [undefined, "", "overview", "../settings", "unknown"])
      expect(resolveReceivingPage(value)).toBe("overview");
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
