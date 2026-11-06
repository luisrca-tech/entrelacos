import type { InvitationExportModel } from "@entrelacos/contracts";
import type { InvitationFilters } from "./invitationView";

export type InvitationExportSelection = {
  model: InvitationExportModel;
  filters?: InvitationFilters;
  includePhone: boolean;
  includeEmail: boolean;
};

export function invitationExportFormat(model: InvitationExportModel) {
  return model === "groups" || model === "guests" ? "csv" : "pdf";
}

export function invitationExportPath(
  siteId: string,
  {
    model,
    filters,
    includePhone,
    includeEmail,
    requestId,
  }: InvitationExportSelection & {
    requestId: string;
  },
): string {
  const format = invitationExportFormat(model);
  const query = new URLSearchParams({
    requestId,
    model,
    includePhone: String(format === "csv" && includePhone),
    includeEmail: String(format === "csv" && includeEmail),
  });
  if (filters && model !== "reception") {
    if (filters.search.trim()) query.set("search", filters.search.trim());
    if (filters.status !== "ALL") query.set("groupStatus", filters.status);
    if (filters.guestType !== "ALL") query.set("guestType", filters.guestType);
  }
  return `/v1/sites/${encodeURIComponent(siteId)}/reports/invitations.${format}?${query.toString()}`;
}
