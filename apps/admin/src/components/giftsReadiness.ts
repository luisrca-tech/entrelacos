import {
  receivingReadinessResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";
import { paymentsAvailabilityStore } from "../lib/paymentsAvailability";

export type GiftCatalogReadiness =
  (typeof receivingReadinessResponseSchema._output)["readiness"] &
    Pick<typeof receivingReadinessResponseSchema._output, "catalogAccess">;

export async function loadGiftsReadiness(
  siteId: string,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<GiftCatalogReadiness> {
  const validSiteId = siteIdSchema.parse(siteId);
  const { readiness, catalogAccess } = receivingReadinessResponseSchema.parse(
    await request(
      `/v1/sites/${encodeURIComponent(validSiteId)}/receiving/readiness`,
    ),
  );
  if (readiness.siteId !== validSiteId)
    throw new Error("Unexpected readiness site");
  // The mode is the API's own word on whether payments exist at all.
  paymentsAvailabilityStore.reportMode(readiness.mode);
  return catalogAccess ? { ...readiness, catalogAccess } : readiness;
}
