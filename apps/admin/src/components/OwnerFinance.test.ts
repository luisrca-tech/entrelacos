import type { OwnerFinanceAlert } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { criticalAlertCount, formatAlertDate } from "./OwnerFinance";

const alert = (severity: OwnerFinanceAlert["severity"]): OwnerFinanceAlert => ({
  id: `alert-${severity}`,
  kind: "SPLIT_DIVERGENCE_BLOCK",
  severity,
  environment: "sandbox",
  siteId: null,
  siteName: null,
  paymentReference: null,
  amountCents: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  dueAt: null,
  asaasPaymentUrl: null,
  resolvedAt: null,
  resolvedNote: null,
});

describe("owner finance helpers", () => {
  it("counts only critical alerts for the menu badge", () => {
    expect(criticalAlertCount([])).toBe(0);
    expect(
      criticalAlertCount([
        alert("critical"),
        alert("warning"),
        alert("critical"),
      ]),
    ).toBe(2);
  });

  it("formats dates in Sao Paulo time and shows a dash for none", () => {
    expect(formatAlertDate(null)).toBe("—");
    expect(formatAlertDate("2026-10-14T12:00:00.000Z")).toContain("14/10/2026");
  });
});
