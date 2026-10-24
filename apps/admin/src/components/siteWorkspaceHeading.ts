import type { SiteRecord } from "@entrelacos/contracts";
import type { SiteArea } from "./adminNavigation";

const areaTitle: Record<SiteArea, string> = {
  home: "Início",
  invitations: "Convites",
  messages: "Mensagens",
  gifts: "Presentes",
  receiving: "Recebimentos",
  "receiving-guide": "Guia do recebedor",
  team: "Equipe",
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
