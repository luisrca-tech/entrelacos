import type {
  ReceivingReadiness,
  SiteAccess,
  SiteRecord,
} from "@entrelacos/contracts";
import { getSiteNavigation, type SiteArea } from "./adminNavigation";

type HomeSite = Pick<SiteRecord, "id" | "lifecycle" | "publicationState">;
export type HomeSection = {
  id: SiteArea;
  label: string;
  href: string;
  description: string;
};
type NextStep = {
  title: string;
  description: string;
  label: string;
  href: string;
};
const descriptions: Partial<Record<SiteArea, string>> = {
  invitations:
    "Organize os convidados, envie os convites e acompanhe as confirmações.",
  messages: "Leia os recados recebidos e cuide do mural do casal.",
  gifts: "Monte a lista de presentes e escolha o que aparece no site.",
  receiving: "Ative os recebimentos e acompanhe pagamentos e saques.",
  team: "Convide quem vai ajudar e gerencie os acessos ao casamento.",
  settings: "Ajuste os dados, as datas, a publicação e o endereço do site.",
};

export function buildSiteHomePlan({
  site,
  access,
  owner,
  readiness,
}: {
  site: HomeSite;
  access: SiteAccess | null;
  owner: boolean;
  readiness: ReceivingReadiness | null;
}): {
  sections: HomeSection[];
  next: NextStep | null;
  receivingLabel: string | null;
} {
  if (!owner && access?.siteId !== site.id)
    return { sections: [], next: null, receivingLabel: null };
  const role = owner ? "OWNER" : access?.membershipRole;
  if (!role) return { sections: [], next: null, receivingLabel: null };
  const sections = getSiteNavigation(role, site.id)
    .filter((item) => item.area !== "home")
    .map((item) => ({
      id: item.area,
      label: item.label,
      href: item.href,
      description: descriptions[item.area] ?? "",
    }));
  const base = `/sites/${encodeURIComponent(site.id)}`;
  const receivingAllowed =
    owner ||
    (access?.membershipRole === "SITE_ADMIN" &&
      access.capabilities.configureReceiving);
  const current =
    receivingAllowed && readiness?.siteId === site.id ? readiness : null;
  const receivingLabel = !receivingAllowed
    ? null
    : !current
      ? "Status não consultado"
      : current.state === "READY"
        ? "Recebimentos liberados"
        : current.reason === "ACCOUNT_UNDER_REVIEW"
          ? "Em análise"
          : current.reason === "PROVIDER_DISABLED" ||
              current.reason === "CAPABILITY_UNAVAILABLE"
            ? "Aguardando habilitação"
            : current.reason === "ACCOUNT_BLOCKED"
              ? "Recebimentos bloqueados"
              : current.reason === "ENVIRONMENT_MISMATCH"
                ? "Revisão necessária"
                : current.reason === "EVIDENCE_STALE"
                  ? "Atualização necessária"
                  : "Configuração pendente";
  const next: NextStep = {
    title: "Cuide dos convites e das confirmações",
    description:
      "Adicione os convidados, compartilhe os convites e acompanhe quem confirmou presença.",
    label: "Organizar convites",
    href: `${base}/invitations`,
  };
  if (site.lifecycle === "INACTIVE")
    return {
      sections,
      receivingLabel,
      next: {
        title: "Este casamento está pausado",
        description: owner
          ? "Confira a situação antes de retomar a organização."
          : "Consulte as informações e fale com o responsável para retomar as alterações.",
        label: owner ? "Revisar situação" : "Consultar convites",
        href: `${base}/${owner ? "settings" : "invitations"}`,
      },
    };
  if (
    owner &&
    (site.lifecycle !== "ACTIVE" || site.publicationState !== "PUBLISHED")
  )
    return {
      sections,
      receivingLabel,
      next: {
        title: "Prepare o site para o casal",
        description:
          "Confira os dados, as datas e a publicação antes de compartilhar o site.",
        label: "Revisar configurações",
        href: `${base}/settings`,
      },
    };
  if (
    current &&
    ["ACCOUNT_BLOCKED", "ENVIRONMENT_MISMATCH"].includes(current.reason ?? "")
  )
    return {
      sections,
      receivingLabel,
      next: {
        title: "Os recebimentos precisam de atenção",
        description:
          "Consulte a situação e fale com o suporte para regularizar os recebimentos antes de continuar.",
        label: "Consultar recebimentos",
        href: `${base}/receiving`,
      },
    };
  if (
    current &&
    current.state !== "READY" &&
    ![
      "ACCOUNT_UNDER_REVIEW",
      "PROVIDER_DISABLED",
      "CAPABILITY_UNAVAILABLE",
    ].includes(current.reason ?? "")
  )
    return {
      sections,
      receivingLabel,
      next: {
        title: "Prepare os recebimentos dos presentes",
        description:
          "Confira o titular e acompanhe as etapas necessárias para liberar os presentes pagos.",
        label: "Acompanhar ativação",
        href: `${base}/receiving/activation`,
      },
    };
  return { sections, next, receivingLabel };
}
