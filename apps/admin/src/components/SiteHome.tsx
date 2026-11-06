import {
  type ReceivingReadiness,
  type SiteAccess,
  type SiteHomeSummary,
  type SiteRecord,
  siteHomeSummarySchema,
} from "@entrelacos/contracts";
import { Badge, Button, toast } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarDays,
  Gift,
  HeartHandshake,
  Link2,
  Mail,
  MessageCircle,
  Settings2,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "../lib/apiClient";
import { formatBrazilianDate } from "./brazilianDate";
import { loadGiftsReadiness } from "./giftsReadiness";
import { HomeAreaCard } from "./HomeAreaCard";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { buildSiteHomePlan, daysUntilWedding } from "./siteHomePlan";

type HomeSite = Pick<
  SiteRecord,
  | "id"
  | "displayName"
  | "coupleNames"
  | "eventDate"
  | "lifecycle"
  | "publicationState"
  | "publicUrl"
  | "isDemo"
>;
type HomeScope = {
  siteId: string;
  access: SiteAccess | null;
  owner: boolean;
  sessionEpoch: number | null;
};
type Props = {
  site: HomeSite;
  access: SiteAccess | null;
  owner: boolean;
  sessionEpoch: number | null;
};

export async function readHomeReceiving(
  scope: HomeScope,
  receive: (readiness: ReceivingReadiness | null, failed: boolean) => void,
  isActive: () => boolean = () => true,
) {
  const captured = panelActorOwner.getSnapshot();
  const membership = captured.actor?.memberships?.find(
    (item) =>
      item.siteId === scope.siteId && item.userId === captured.actor?.user.id,
  );
  const allowed = scope.owner
    ? captured.actor?.user.role === "OWNER"
    : membership?.membershipRole === "SITE_ADMIN" &&
      membership.capabilities.configureReceiving &&
      JSON.stringify(membership) === JSON.stringify(scope.access);
  const current = () =>
    isActive() &&
    allowed &&
    captured.status === "verified" &&
    captured.actor !== null &&
    Date.parse(captured.actor.session.expiresAt) > Date.now() &&
    scope.sessionEpoch !== null &&
    captured.sessionEpoch === scope.sessionEpoch &&
    panelActorOwner.getSnapshot() === captured;
  if (!current()) return;
  try {
    const readiness = await loadGiftsReadiness(scope.siteId);
    if (current()) receive(readiness, false);
  } catch (cause) {
    if (!current()) return;
    panelActorOwner.reportFailure(cause, scope.sessionEpoch);
    if (current()) receive(null, true);
  }
}

export function SiteHome({ site, access, owner, sessionEpoch }: Props) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    siteId: string;
    epoch: number | null;
    summary: SiteHomeSummary | null;
    failed: boolean;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry increments revision.
  useEffect(() => {
    let active = true;
    setResult(null);
    const current = () => active && isCurrentPanelSessionEpoch(sessionEpoch);
    if (current()) {
      void apiRequest(`/v1/sites/${encodeURIComponent(site.id)}/home-summary`)
        .then((response) => {
          if (!current()) return;
          const summary = siteHomeSummarySchema.parse(response);
          if (summary.receiving && summary.receiving.siteId !== site.id)
            throw new Error("Unexpected summary site");
          setResult({
            siteId: site.id,
            epoch: sessionEpoch,
            summary,
            failed: false,
          });
        })
        .catch((cause) => {
          if (!current()) return;
          panelActorOwner.reportFailure(cause, sessionEpoch);
          if (!current()) return;
          setResult({
            siteId: site.id,
            epoch: sessionEpoch,
            summary: null,
            failed: true,
          });
          void readHomeReceiving(
            { siteId: site.id, access, owner, sessionEpoch },
            (readiness) => {
              if (readiness)
                setResult({
                  siteId: site.id,
                  epoch: sessionEpoch,
                  summary: { receiving: readiness },
                  failed: true,
                });
            },
            current,
          );
        });
    }
    return () => {
      active = false;
    };
  }, [site.id, access, owner, sessionEpoch, revision]);
  const current =
    result?.siteId === site.id && result.epoch === sessionEpoch ? result : null;
  return (
    <SiteHomeView
      site={site}
      access={access}
      owner={owner}
      summary={current?.summary}
      readiness={current?.summary?.receiving ?? null}
      loading={!current}
      failed={current?.failed ?? false}
      onRetry={() => setRevision((value) => value + 1)}
    />
  );
}

const sectionIcons = {
  invitations: Mail,
  messages: MessageCircle,
  gifts: Gift,
  receiving: Wallet,
  team: Users,
  settings: Settings2,
  home: HeartHandshake,
  "receiving-guide": HeartHandshake,
};
function areaSummary(
  section: string,
  summary: SiteHomeSummary | null | undefined,
) {
  if (section === "invitations" && summary?.invitations) {
    const { total, confirmed, pending, declined } = summary.invitations;
    return {
      active: total > 0,
      text: `${confirmed} de ${confirmed + pending + declined} confirmados`,
    };
  }
  if (section === "messages" && summary?.messages !== undefined)
    return {
      active: summary.messages > 0,
      text: `${summary.messages} no mural`,
    };
  if (section === "gifts" && summary?.publishedGifts !== undefined) {
    const received = summary.receivedGifts;
    return {
      active: summary.publishedGifts > 0,
      text: `${summary.publishedGifts} publicados${received === undefined ? "" : ` · ${received} recebidos`}`,
    };
  }
  if (section === "receiving" && summary?.receiving)
    return { active: summary.receiving.state === "READY", text: null };
  if (section === "team" && summary?.peopleWithAccess !== undefined)
    return {
      active: summary.peopleWithAccess > 0,
      text: `${summary.peopleWithAccess} com acesso`,
    };
  return null;
}

export function SiteHomeView({
  site,
  access,
  owner,
  readiness,
  summary,
  loading,
  failed,
  onRetry,
}: {
  site: HomeSite;
  access: SiteAccess | null;
  owner: boolean;
  readiness: ReceivingReadiness | null;
  summary?: SiteHomeSummary | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const plan = buildSiteHomePlan({ site, access, owner, readiness });
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setDays(daysUntilWedding(site.eventDate, new Date()));
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [site.eventDate]);

  async function copySite() {
    if (!site.publicUrl) return;
    try {
      await navigator.clipboard.writeText(site.publicUrl);
      toast.success("Endereço do site copiado.");
    } catch {
      toast.error("Não foi possível copiar o endereço do site.");
    }
  }

  return (
    <div className="grid gap-5" data-area="home">
      <section
        className="grid overflow-hidden rounded-2xl border border-admin-line bg-admin-surface sm:grid-cols-[3fr_2fr]"
        aria-label="Seu casamento"
      >
        <div className="grid content-center gap-3 p-5 sm:p-8">
          <p className={adminHomeEyebrow}>Seu casamento</p>
          <h2 className="m-0 break-words font-admin-display text-4xl font-normal sm:text-[42px]">
            {site.coupleNames.join(" & ")}
          </h2>
          <div className="flex flex-wrap items-center gap-2.5 text-[15px]">
            <CalendarDays
              className="size-4 text-admin-terracotta-deep"
              aria-hidden="true"
            />
            <time dateTime={site.eventDate}>
              {formatBrazilianDate(site.eventDate)}
            </time>
            {days !== null && days >= 0 && (
              <Badge className="bg-admin-terracotta-wash text-admin-terracotta-ink">
                {days === 0
                  ? "É hoje"
                  : days === 1
                    ? "Falta 1 dia"
                    : `Faltam ${days} dias`}
              </Badge>
            )}
          </div>
        </div>
        <div className="grid min-w-0 content-center gap-3 border-t border-admin-line bg-admin-beige p-5 sm:border-t-0 sm:border-l sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-muted">
              Site do casal
            </p>
            <Badge
              variant="secondary"
              className={
                site.publicationState === "PUBLISHED"
                  ? "bg-admin-success-wash text-admin-success-ink"
                  : "bg-admin-surface text-admin-muted"
              }
            >
              {site.publicationState === "PUBLISHED"
                ? "Site publicado"
                : site.publicationState === "PLACEHOLDER"
                  ? "Página neutra"
                  : "Não publicado"}
            </Badge>
          </div>
          {site.publicUrl ? (
            <>
              <p className="m-0 flex min-w-0 items-center gap-2 rounded-lg border border-admin-line bg-admin-surface px-3 py-2 text-sm [overflow-wrap:anywhere]">
                <Link2 className="size-4 shrink-0" aria-hidden="true" />
                {site.publicUrl}
              </p>
              <div className="flex flex-wrap items-center gap-3.5">
                <Button
                  type="button"
                  variant="outline"
                  className="border-admin-line-strong bg-transparent"
                  onClick={() => void copySite()}
                >
                  Copiar
                </Button>
                <a
                  href={site.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-admin-terracotta-deep underline"
                >
                  Abrir site
                </a>
              </div>
            </>
          ) : (
            <p className="m-0 text-sm text-admin-muted">Site não vinculado</p>
          )}
        </div>
      </section>
      {plan.next && (
        <section
          className="flex flex-col items-start justify-between gap-5 rounded-2xl border border-admin-terracotta bg-admin-terracotta-wash p-5 sm:flex-row sm:items-center sm:p-7"
          aria-label="Próximo passo"
        >
          <div className="grid gap-2">
            <p className={adminHomeEyebrow}>Próximo passo</p>
            <h2 className="m-0 font-admin-display text-2xl font-normal sm:text-[28px]">
              {plan.next.title}
            </h2>
            <p className="m-0 text-sm leading-relaxed text-admin-body">
              {plan.next.description}
            </p>
          </div>
          <Button
            nativeButton={false}
            className="w-full shrink-0 bg-admin-terracotta text-white hover:bg-admin-terracotta-deep sm:w-auto"
            render={<Link to={plan.next.href} />}
          >
            {plan.next.label}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </section>
      )}
      <section className="grid gap-3" aria-labelledby="home-areas-title">
        <div>
          <h2
            id="home-areas-title"
            className="m-0 font-admin-display text-2xl font-normal"
          >
            Como o painel funciona
          </h2>
          <p className="mt-1 mb-0 text-sm text-admin-muted">
            Cada área cuida de uma parte do casamento. Você pode voltar aqui
            quando precisar.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {plan.sections
            .filter((section) => section.id !== "settings")
            .map((section) => {
              const current = areaSummary(section.id, summary);
              const label =
                section.id === "receiving" && readiness
                  ? plan.receivingLabel
                  : current
                    ? current.active
                      ? "Em uso"
                      : "Não iniciado"
                    : loading
                      ? "Consultando"
                      : "Situação indisponível";
              return (
                <HomeAreaCard
                  key={section.id}
                  href={section.href}
                  icon={sectionIcons[section.id]}
                  title={section.label}
                  description={section.description}
                  action={
                    current && !current.active && site.lifecycle !== "INACTIVE"
                      ? "Começar"
                      : "Abrir"
                  }
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-admin-muted">
                    <Badge
                      variant="secondary"
                      className={
                        current?.active
                          ? "bg-admin-success-wash text-admin-success-ink"
                          : "bg-admin-beige text-admin-muted"
                      }
                    >
                      {label}
                    </Badge>
                    {current?.text}
                  </div>
                </HomeAreaCard>
              );
            })}
        </div>
        {failed && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-admin-muted">
            <span>Não foi possível atualizar o resumo do casamento.</span>
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
const adminHomeEyebrow =
  "m-0 text-xs font-bold uppercase tracking-wider text-admin-terracotta-deep";
