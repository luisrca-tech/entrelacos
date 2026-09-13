import type { RsvpState } from "@entrelacos/contracts";

export type RsvpExportFormat = "csv" | "pdf";

export type RsvpExportSelection = {
  requestId: string;
  includePhone: boolean;
  groupId?: string;
  state?: RsvpState;
};

export function rsvpExportPath(
  siteId: string,
  format: RsvpExportFormat,
  selection: RsvpExportSelection,
): string {
  const query = new URLSearchParams({
    requestId: selection.requestId,
    includePhone: String(selection.includePhone),
  });
  if (selection.groupId) query.set("groupId", selection.groupId);
  if (selection.state) query.set("state", selection.state);
  return `/v1/sites/${encodeURIComponent(siteId)}/reports/rsvp.${format}?${query.toString()}`;
}

export function exportFilename(
  contentDisposition: string | null,
  fallback: string,
): string {
  const match = contentDisposition?.match(/filename="([A-Za-z0-9._-]+)"/i);
  return match?.[1] ?? fallback;
}
