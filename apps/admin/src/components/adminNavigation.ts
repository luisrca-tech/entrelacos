export type AdminRole = "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT";

export const siteAreas = [
  "home",
  "invitations",
  "messages",
  "gifts",
  "receiving",
  "receiving-guide",
  "team",
  "settings",
] as const;

export type SiteArea = (typeof siteAreas)[number];

export type SiteNavigationItem = {
  area: SiteArea;
  label: string;
  href: string;
  ownerOnly?: boolean;
};

const labels: Record<SiteArea, string> = {
  home: "Início",
  invitations: "Convites",
  messages: "Mensagens",
  gifts: "Presentes",
  receiving: "Recebimentos",
  "receiving-guide": "Guia do recebedor",
  team: "Equipe",
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
  const areas: SiteArea[] = ["home", "invitations", "messages", "gifts"];
  if (role === "SITE_ADMIN" || role === "OWNER") areas.push("receiving");
  if (role !== "SITE_ASSISTANT") areas.push("team");
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
    return "home";
  }
  if (requestedArea === "settings" && role !== "OWNER") return "home";
  if (
    (requestedArea === "receiving" || requestedArea === "receiving-guide") &&
    role === "SITE_ASSISTANT"
  )
    return "home";
  if (requestedArea === "team" && role === "SITE_ASSISTANT") return "home";
  return requestedArea as SiteArea;
}

export function getMobileNavigation(items: SiteNavigationItem[]) {
  if (items.length <= 5) return { primary: items, more: [] };
  const primaryAreas = new Set<SiteArea>([
    "home",
    "invitations",
    "gifts",
    "receiving",
  ]);
  return {
    primary: items.filter((item) => primaryAreas.has(item.area)),
    more: items.filter((item) => !primaryAreas.has(item.area)),
  };
}

export const initialsFromName = getInitials;
export const siteNavigationFor = getSiteNavigation;
export const safeSiteArea = resolveSiteArea;
