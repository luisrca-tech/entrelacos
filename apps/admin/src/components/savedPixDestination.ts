import {
  type ReceivingPixDestinationSaved,
  receivingPixDestinationSavedResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export type SavedPixDestinationSummary = Pick<
  ReceivingPixDestinationSaved,
  "ownerName" | "keyType" | "maskedKey" | "bankName"
>;

// A display-only read: any failure leaves the destination out of the page.
export async function loadSavedPixDestination(
  siteId: string,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<SavedPixDestinationSummary | null> {
  try {
    const validSiteId = siteIdSchema.parse(siteId);
    const { destination } = receivingPixDestinationSavedResponseSchema.parse(
      await request(
        `/v1/sites/${encodeURIComponent(validSiteId)}/receiving/pix-destination`,
      ),
    );
    if (!destination || destination.siteId !== validSiteId) return null;
    const { ownerName, keyType, maskedKey, bankName } = destination;
    return { ownerName, keyType, maskedKey, bankName };
  } catch {
    return null;
  }
}
