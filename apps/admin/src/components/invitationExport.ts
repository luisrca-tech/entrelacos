import type { InvitationFilters } from "./invitationView";

export type InvitationExportFormat = "csv" | "pdf";
export type InvitationExportSelection = InvitationFilters & {
  requestId: string;
  includePhone?: boolean;
  includeEmail?: boolean;
};

export function invitationExportPath(
  siteId: string,
  format: InvitationExportFormat,
  selection: InvitationExportSelection,
): string {
  const query = new URLSearchParams({
    requestId: selection.requestId,
    includePhone: String(selection.includePhone === true),
    includeEmail: String(selection.includeEmail === true),
  });
  if (selection.search.trim()) query.set("search", selection.search.trim());
  if (selection.status !== "ALL") query.set("status", selection.status);
  if (selection.guestType !== "ALL")
    query.set("guestType", selection.guestType);
  return `/v1/sites/${encodeURIComponent(siteId)}/reports/invitations.${format}?${query.toString()}`;
}
