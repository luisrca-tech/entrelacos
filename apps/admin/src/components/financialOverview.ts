import {
  type FinancialOverview,
  financialOverviewResponseSchema,
  type SiteAccess,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export function canReadFinancialOverview(
  siteId: string,
  access: SiteAccess | null,
): boolean {
  const parsed = siteAccessSchema.safeParse(access);
  return (
    parsed.success &&
    parsed.data.siteId === siteId &&
    ((parsed.data.membershipRole === "SITE_ADMIN" &&
      parsed.data.membershipId !== null) ||
      (parsed.data.membershipRole === "OWNER" &&
        parsed.data.membershipId === null &&
        !parsed.data.capabilities.configureReceiving &&
        !parsed.data.capabilities.requestWithdrawal)) &&
    parsed.data.capabilities.readFinance
  );
}

export async function loadFinancialOverview(
  siteId: string,
  access: SiteAccess | null,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<FinancialOverview> {
  const validSiteId = siteIdSchema.parse(siteId);
  if (!canReadFinancialOverview(validSiteId, access))
    throw new Error("Financial access denied");
  const { overview } = financialOverviewResponseSchema.parse(
    await request(`/v1/sites/${encodeURIComponent(validSiteId)}/finance`),
  );
  if (overview.siteId !== validSiteId)
    throw new Error("Unexpected financial site");
  return overview;
}
