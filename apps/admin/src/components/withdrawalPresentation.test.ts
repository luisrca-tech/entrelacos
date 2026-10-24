import type { WithdrawalRequestStatus } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { isActionableWithdrawalRequest } from "./withdrawalPresentation";

describe("withdrawal recovery visibility", () => {
  it("retains open and unresolved requests for safe continuation", () => {
    for (const state of ["OPEN", "UNRESOLVED"])
      expect(
        isActionableWithdrawalRequest({ state } as WithdrawalRequestStatus),
      ).toBe(true);
  });
  it("keeps uncertain transfers actionable but removes settled history from the action list", () => {
    for (const state of [
      "REQUESTED",
      "AWAITING_AUTHORIZATION",
      "PROCESSING",
      "UNKNOWN",
    ])
      expect(
        isActionableWithdrawalRequest({
          state: "EXISTING",
          withdrawal: { state },
        } as WithdrawalRequestStatus),
      ).toBe(true);
    for (const state of ["COMPLETED", "FAILED", "CANCELLED"])
      expect(
        isActionableWithdrawalRequest({
          state: "EXISTING",
          withdrawal: { state },
        } as WithdrawalRequestStatus),
      ).toBe(false);
    expect(
      isActionableWithdrawalRequest({
        state: "SEALED_NOT_CREATED",
      } as WithdrawalRequestStatus),
    ).toBe(false);
  });
});
