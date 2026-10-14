import {
  type SiteAccess,
  siteIdSchema,
  type WithdrawalIntent,
  withdrawalListResponseSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";
import { canReadFinancialOverview } from "./financialOverview";

export type WithdrawalHistoryResult =
  | { status: "loading" }
  | { status: "ready"; withdrawals: WithdrawalIntent[] }
  | { status: "unavailable" }
  | { status: "error" };

export function parseWithdrawalHistory(
  siteId: string,
  value: unknown,
): WithdrawalIntent[] {
  const validSiteId = siteIdSchema.parse(siteId);
  const { withdrawals } = withdrawalListResponseSchema.parse(value);
  const ids = new Set<string>();
  for (const withdrawal of withdrawals) {
    if (
      withdrawal.siteId !== validSiteId ||
      ids.has(withdrawal.id) ||
      Date.parse(withdrawal.updatedAt) < Date.parse(withdrawal.createdAt)
    )
      throw new Error("Invalid withdrawal history");
    ids.add(withdrawal.id);
  }
  return withdrawals;
}

export async function loadWithdrawalHistory(
  siteId: string,
  access: SiteAccess | null,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<WithdrawalIntent[]> {
  const validSiteId = siteIdSchema.parse(siteId);
  if (!canReadFinancialOverview(validSiteId, access))
    throw new Error("Financial access denied");
  return parseWithdrawalHistory(
    validSiteId,
    await request(`/v1/sites/${encodeURIComponent(validSiteId)}/withdrawals`),
  );
}
