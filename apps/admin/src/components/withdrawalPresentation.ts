import type { WithdrawalRequestStatus } from "@entrelacos/contracts";

export function isActionableWithdrawalRequest(
  request: WithdrawalRequestStatus,
): boolean {
  if (request.state === "OPEN" || request.state === "UNRESOLVED") return true;
  return (
    request.state === "EXISTING" &&
    ["REQUESTED", "AWAITING_AUTHORIZATION", "PROCESSING", "UNKNOWN"].includes(
      request.withdrawal.state,
    )
  );
}
