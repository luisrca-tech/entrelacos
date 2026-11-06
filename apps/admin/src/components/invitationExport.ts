import type { InvitationFilters } from "./invitationView";

export type InvitationExportFormat = "csv" | "pdf";
type ExportFilters = InvitationFilters & {
  status: Exclude<InvitationFilters["status"], "PARTIAL">;
};
export type InvitationExportSelection = ExportFilters & {
  requestId: string;
  includePhone?: boolean;
  includeEmail?: boolean;
};

/**
 * The report lists guests and filters them by their own answer. A mixed
 * answer only exists per invitation, so the partial filter exports every
 * answer and the Status column tells them apart.
 */
export function exportableFilters(filters: InvitationFilters): ExportFilters {
  return {
    ...filters,
    status: filters.status === "PARTIAL" ? "ALL" : filters.status,
  };
}

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
