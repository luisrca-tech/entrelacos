import {
  type ReceivingNominationContext,
  receivingNominationContextResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export async function loadReceivingNominationContext(
  siteId: string,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<ReceivingNominationContext> {
  const validSiteId = siteIdSchema.parse(siteId);
  const { context } = receivingNominationContextResponseSchema.parse(
    await request(
      `/v1/sites/${encodeURIComponent(validSiteId)}/receiving/nomination-context`,
    ),
  );
  if (context.siteId !== validSiteId)
    throw new Error("Unexpected nomination context site");
  return context;
}
