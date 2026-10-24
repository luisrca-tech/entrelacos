import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import {
  siteIdSchema,
  siteScopedReadResponseSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export async function loadAssignedSiteName(
  siteId: string,
  request: (path: string) => Promise<unknown> = apiRequest,
): Promise<string> {
  const id = siteIdSchema.parse(siteId);
  const { site } = siteScopedReadResponseSchema.parse(
    await request(`/v1/sites/${encodeURIComponent(id)}`),
  );
  if (site.id !== id) throw new Error("Unexpected assigned site");
  return site.displayName;
}

export function getPanelLanding(
  actor: MeResponse,
): { kind: "OWNER" | "EMPTY" | "SELECT" } | { kind: "SITE"; siteId: string } {
  if (actor.user.role === "OWNER") return { kind: "OWNER" };
  const memberships = (actor.memberships ?? []).filter(
    (entry) => entry.userId === actor.user.id,
  );
  if (memberships.length === 0) return { kind: "EMPTY" };
  if (memberships.length === 1)
    return { kind: "SITE", siteId: memberships[0].siteId };
  return { kind: "SELECT" };
}

export function getSelectedSiteAccess(
  actor: MeResponse,
  siteId: string,
): SiteAccess | null {
  return (
    actor.memberships?.find(
      (entry) => entry.siteId === siteId && entry.userId === actor.user.id,
    ) ?? null
  );
}
