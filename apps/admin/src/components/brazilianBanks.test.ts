import { describe, expect, it } from "vitest";
import {
  brazilianBanks,
  normalizeBankCode,
  otherBankValue,
} from "./brazilianBanks";

describe("brazilian banks", () => {
  it("lists unique three-digit codes labelled by name and code", () => {
    const codes = brazilianBanks.map((bank) => bank.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const bank of brazilianBanks) {
      expect(bank.code).toMatch(/^\d{3}$/);
      expect(bank.label).toBe(`${bank.name} (${bank.code})`);
    }
    expect(codes).toContain("260");
    expect(codes).not.toContain(otherBankValue);
  });

  it("accepts the 4-digit codes bank apps show with a leading zero", () => {
    expect(normalizeBankCode("0260")).toBe("260");
    expect(normalizeBankCode(" 260 ")).toBe("260");
    expect(normalizeBankCode("001")).toBe("001");
    expect(normalizeBankCode("0001")).toBe("001");
  });

  it("keeps anything else unchanged so the contract rejects it", () => {
    expect(normalizeBankCode("34")).toBe("34");
    expect(normalizeBankCode("1260")).toBe("1260");
    expect(normalizeBankCode("abc")).toBe("abc");
    expect(normalizeBankCode("")).toBe("");
  });
});
