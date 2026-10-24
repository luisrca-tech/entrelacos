import {
  type ReceivingReadiness,
  receivingReadinessResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export async function loadGiftsReadiness(
  siteId: string,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<ReceivingReadiness> {
  const validSiteId = siteIdSchema.parse(siteId);
  const { readiness } = receivingReadinessResponseSchema.parse(
    await request(
      `/v1/sites/${encodeURIComponent(validSiteId)}/receiving/readiness`,
    ),
  );
  if (readiness.siteId !== validSiteId)
    throw new Error("Unexpected readiness site");
  return readiness;
}
