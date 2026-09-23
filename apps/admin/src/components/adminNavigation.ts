export type AdminRole = "OWNER" | "SITE_ADMIN";

export const siteAreas = ["invitations", "messages", "settings"] as const;

export type SiteArea = (typeof siteAreas)[number];

export type SiteNavigationItem = {
  area: SiteArea;
  label: string;
  href: string;
  ownerOnly?: boolean;
};

const labels: Record<SiteArea, string> = {
  invitations: "Convites",
  messages: "Mensagens",
  settings: "Configurações",
};

export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1)
    return Array.from(words[0]).slice(0, 1).join("").toUpperCase();
  return `${Array.from(words[0])[0] ?? ""}${Array.from(words.at(-1) ?? "")[0] ?? ""}`.toUpperCase();
}

export function getSiteNavigation(
  role: AdminRole,
  siteId: string,
): SiteNavigationItem[] {
  const encodedSiteId = encodeURIComponent(siteId);
  const areas: SiteArea[] = ["invitations", "messages"];
  if (role === "OWNER") areas.push("settings");
  return areas.map((area) => ({
    area,
    label: labels[area],
    href: `/sites/${encodedSiteId}/${area}`,
    ...(area === "settings" ? { ownerOnly: true } : {}),
  }));
}

export function resolveSiteArea(
  role: AdminRole,
  requestedArea: string | undefined,
): SiteArea {
  if (!requestedArea || !siteAreas.includes(requestedArea as SiteArea)) {
    return "invitations";
  }
  if (requestedArea === "settings" && role !== "OWNER") return "invitations";
  return requestedArea as SiteArea;
}

export const initialsFromName = getInitials;
export const siteNavigationFor = getSiteNavigation;
export const safeSiteArea = resolveSiteArea;
