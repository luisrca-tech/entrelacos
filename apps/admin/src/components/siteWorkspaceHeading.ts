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
  coupleNames,
}: {
  area: SiteArea;
  owner: boolean;
  lifecycle: SiteRecord["lifecycle"];
  coupleNames?: readonly string[];
}) {
  return {
    title: areaTitle[area],
    subtitle:
      area === "settings" && coupleNames?.length
        ? `Cadastro, datas e publicação do casamento de ${coupleNames.join(" & ")}.`
        : null,
    showBackLink: owner,
    // Owner settings show the lifecycle in their status strip instead.
    showLifecycleBadge:
      area !== "settings" && (owner || lifecycle === "INACTIVE"),
    // These areas show a task-specific title and actions of their own.
    ownPageHeader: area === "receiving" || area === "gifts",
  };
}
