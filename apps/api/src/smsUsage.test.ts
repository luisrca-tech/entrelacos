import { describe, expect, it } from "vitest";
import { smsPeriod, smsUsageAlert } from "./smsUsage";

describe("SMS usage calculations", () => {
  it("uses the civil month in America/Sao_Paulo", () => {
    expect(smsPeriod(new Date("2028-03-01T02:59:59.999Z"))).toEqual({
      periodStart: new Date("2028-02-01T03:00:00.000Z"),
      periodEnd: new Date("2028-03-01T03:00:00.000Z"),
    });
    expect(smsPeriod(new Date("2028-03-01T03:00:00.000Z"))).toEqual({
      periodStart: new Date("2028-03-01T03:00:00.000Z"),
      periodEnd: new Date("2028-04-01T03:00:00.000Z"),
    });
  });

  it("compares alert thresholds with exact integers", () => {
    expect(smsUsageAlert(null, 0)).toBe("NOT_CONFIGURED");
    expect(smsUsageAlert(100, 79)).toBe("BELOW_80");
    expect(smsUsageAlert(100, 80)).toBe("AT_OR_ABOVE_80");
    expect(smsUsageAlert(100, 99)).toBe("AT_OR_ABOVE_80");
    expect(smsUsageAlert(100, 100)).toBe("AT_OR_ABOVE_100");
    expect(smsUsageAlert(0, 0)).toBe("AT_OR_ABOVE_100");
  });
});
