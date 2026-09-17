import type { SiteRecord } from "@entrelacos/contracts";
import type { SiteArea } from "./adminNavigation";

const areaCopy: Record<SiteArea, { title: string; lede: string }> = {
  overview: {
    title: "Visão geral",
    lede: "Status e datas deste casamento.",
  },
  guests: {
    title: "Convidados",
    lede: "Grupos, convites e listas.",
  },
  rsvp: {
    title: "Confirmações",
    lede: "Respostas dos convidados.",
  },
  messages: {
    title: "Mensagens",
    lede: "Recados deixados no site.",
  },
  settings: {
    title: "Configurações",
    lede: "Ciclo de vida, acessos e domínios.",
  },
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
    ...areaCopy[area],
    showBackLink: owner,
    showLifecycleBadge: owner || lifecycle === "INACTIVE",
  };
}
