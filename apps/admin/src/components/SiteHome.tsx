import type {
  ReceivingReadiness,
  SiteAccess,
  SiteRecord,
} from "@entrelacos/contracts";
import { Badge, Button } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarDays,
  Gift,
  HeartHandshake,
  Mail,
  MessageCircle,
  Settings2,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { formatBrazilianDate } from "./brazilianDate";
import { loadGiftsReadiness } from "./giftsReadiness";
import { panelActorOwner } from "./panelActor";
import { buildSiteHomePlan } from "./siteHomePlan";

type HomeSite = Pick<
  SiteRecord,
  | "id"
  | "displayName"
  | "coupleNames"
  | "eventDate"
  | "lifecycle"
  | "publicationState"
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

export function SiteHome(props: Props) {
  const { site, access, owner, sessionEpoch } = props;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    siteId: string;
    epoch: number | null;
    readiness: ReceivingReadiness | null;
    failed: boolean;
  } | null>(null);
  const eligible =
    owner ||
    (access?.siteId === site.id &&
      access.membershipRole === "SITE_ADMIN" &&
      access.capabilities.configureReceiving);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry refreshes only this optional, server-owned status.
  useEffect(() => {
    let active = true;
    setResult(null);
    if (eligible)
      void readHomeReceiving(
        { siteId: site.id, access, owner, sessionEpoch },
        (readiness, failed) =>
          setResult({
            siteId: site.id,
            epoch: sessionEpoch,
            readiness,
            failed,
          }),
        () => active,
      );
    return () => {
      active = false;
    };
  }, [site.id, access, owner, sessionEpoch, eligible, revision]);
  const current =
    result?.siteId === site.id && result.epoch === sessionEpoch ? result : null;
  return (
    <SiteHomeView
      site={site}
      access={access}
      owner={owner}
      readiness={current?.readiness ?? null}
      loading={eligible && !current}
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
export function SiteHomeView({
  site,
  access,
  owner,
  readiness,
  loading,
  failed,
  onRetry,
}: {
  site: HomeSite;
  access: SiteAccess | null;
  owner: boolean;
  readiness: ReceivingReadiness | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const plan = buildSiteHomePlan({ site, access, owner, readiness });
  return (
    <div className="grid gap-7" data-area="home">
      <section
        className="grid overflow-hidden rounded-2xl border border-admin-line bg-admin-surface lg:grid-cols-[minmax(0,1fr)_260px]"
        aria-label="Seu ponto de partida"
      >
        <div className="grid content-center gap-3 p-5 sm:gap-4 sm:p-8">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-admin-terracotta-deep">
            <HeartHandshake className="size-4" aria-hidden="true" />
            Seu ponto de partida
          </div>
          <h2 className="m-0 max-w-xl font-admin-display text-2xl font-normal leading-tight sm:text-4xl">
            Um passo de cada vez.
            <br />
            Tudo no mesmo lugar.
          </h2>
          <p className="m-0 max-w-xl text-sm leading-relaxed text-admin-muted sm:text-base">
            Dos primeiros convites aos presentes recebidos, este é o espaço para
            cuidar do casamento de {site.coupleNames.join(" e ")}.
          </p>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] content-center items-center justify-items-start gap-x-3 gap-y-2 border-t border-admin-line bg-admin-beige p-4 sm:p-6 lg:grid-cols-1 lg:gap-3 lg:border-t-0 lg:border-l lg:p-8">
          <CalendarDays
            aria-hidden="true"
            className="row-span-2 size-6 text-admin-terracotta-deep lg:row-span-1"
          />
          <span className="sr-only text-xs font-semibold uppercase tracking-wider text-admin-muted lg:not-sr-only">
            O grande dia
          </span>
          <strong className="col-start-2 font-admin-display text-2xl font-normal text-admin-graphite lg:col-start-auto lg:text-3xl">
            {formatBrazilianDate(site.eventDate)}
          </strong>
          <div className="col-start-2 flex flex-wrap gap-2 lg:col-start-auto">
            <Badge variant="outline">
              {site.publicationState === "PUBLISHED"
                ? "Site publicado"
                : site.publicationState === "PLACEHOLDER"
                  ? "Página de apresentação"
                  : "Site não publicado"}
            </Badge>
            {site.isDemo && <Badge variant="secondary">Demonstração</Badge>}
          </div>
        </div>
      </section>
      {plan.next && (
        <section
          className="flex flex-col items-start justify-between gap-5 rounded-xl border border-admin-line bg-admin-terracotta-wash p-5 sm:flex-row sm:items-center sm:p-6"
          aria-label="Próximo passo"
        >
          <div className="grid gap-2">
            <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-terracotta-deep">
              Próximo passo
            </p>
            <h2 className="m-0 font-admin-display text-2xl font-normal">
              {plan.next.title}
            </h2>
            <p className="m-0 max-w-2xl text-sm leading-relaxed text-admin-muted">
              {plan.next.description}
            </p>
          </div>
          <Button
            nativeButton={false}
            className="shrink-0"
            render={<Link to={plan.next.href} />}
          >
            {plan.next.label}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </section>
      )}
      <section className="grid gap-4" aria-labelledby="home-areas-title">
        <div>
          <h2
            id="home-areas-title"
            className="m-0 font-admin-display text-2xl font-normal"
          >
            Encontre o que precisa
          </h2>
          <p className="mt-2 mb-0 text-sm text-admin-muted">
            Cada área tem seu papel. Você pode voltar aqui quando quiser.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plan.sections.map((section) => {
            const Icon = sectionIcons[section.id];
            return (
              <Link
                key={section.id}
                to={section.href}
                className="group grid content-start gap-4 rounded-xl border border-admin-line bg-admin-surface p-5 text-admin-graphite no-underline transition-colors hover:border-admin-terracotta focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-admin-terracotta sm:p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="grid size-10 place-items-center rounded-lg bg-admin-paper text-admin-terracotta-deep">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <ArrowRight
                    className="size-4 text-admin-muted transition-transform group-hover:translate-x-1 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </div>
                <div>
                  <h3 className="m-0 font-semibold">{section.label}</h3>
                  <p className="mt-2 mb-0 text-sm leading-relaxed text-admin-muted">
                    {section.description}
                  </p>
                </div>
                {section.id === "receiving" && plan.receivingLabel && (
                  <Badge variant="outline" className="w-fit">
                    {loading
                      ? "Consultando situação…"
                      : failed
                        ? "Consulta indisponível"
                        : plan.receivingLabel}
                  </Badge>
                )}
              </Link>
            );
          })}
        </div>
        {failed && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-admin-muted">
            <span>Não foi possível atualizar a situação dos recebimentos.</span>
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        )}
      </section>
      <details className="rounded-xl border border-admin-line bg-admin-surface p-5 text-sm text-admin-muted">
        <summary className="cursor-pointer font-semibold text-admin-graphite">
          Como o painel e o site do casal se conectam
        </summary>
        <div className="mt-3 grid max-w-3xl gap-3 leading-relaxed">
          <p className="m-0">
            Este painel é o espaço privado de organização. No site do casal, os
            convidados acessam os convites, confirmam presença, deixam mensagens
            e escolhem presentes.
          </p>
          {plan.receivingLabel !== null && (
            <p className="m-0">
              A lista de presentes pagos fica disponível depois da ativação dos
              recebimentos. O dinheiro recebido e o saldo liberado para saque
              podem ser diferentes; acompanhe essas etapas em Recebimentos.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
