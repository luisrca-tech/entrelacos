import { describe, expect, it } from "vitest";
import { smsUsageProgress } from "./smsUsage";

describe("SMS usage presentation", () => {
  it("keeps an unconfigured limit distinct from zero and avoids rounding thresholds", () => {
    expect(smsUsageProgress(0, null)).toBeNull();
    expect(smsUsageProgress(0, 0)).toBe(100);
    expect(smsUsageProgress(79, 100)).toBe(79);
    expect(smsUsageProgress(81, 100)).toBe(81);
    expect(smsUsageProgress(120, 100)).toBe(100);
  });
});
