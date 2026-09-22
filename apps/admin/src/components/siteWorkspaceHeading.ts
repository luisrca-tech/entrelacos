import type { SiteRecord } from "@entrelacos/contracts";
import type { SiteArea } from "./adminNavigation";

const areaTitle: Record<SiteArea, string> = {
  guests: "Convidados",
  rsvp: "Confirmações",
  messages: "Mensagens",
  settings: "Configurações",
};

export function getWorkspaceHeading({
  area,
  owner,
  lifecycle,
}: {
  area: SiteArea;
  owner: boolean;
  lifecycle: SiteRecord["lifecycle"];
}) {
  return {
    title: areaTitle[area],
    showBackLink: owner,
    showLifecycleBadge: owner || lifecycle === "INACTIVE",
  };
}
