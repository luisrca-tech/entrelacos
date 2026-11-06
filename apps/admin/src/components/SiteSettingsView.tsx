import type {
  adminSummarySchema,
  SiteRecord,
  SiteUpdateInput,
  siteDomainRecordSchema,
} from "@entrelacos/contracts";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@entrelacos/ui";
import { ChevronDown } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { getInitials } from "./adminNavigation";
import { formatBrazilianDate, formatBrazilianWeekday } from "./brazilianDate";
import { GeneratedAccessLink } from "./GeneratedAccessLink";
import { OverflowMenu } from "./OverflowMenu";
import {
  validatePublicAddress,
  validateTrustedOrigins,
} from "./ownerSiteAddresses";
import { ToneBadge } from "./receivingUi";
import { StatusSignal } from "./StatusSignal";
import { daysUntilWedding } from "./siteHomePlan";
import {
  type LifecycleAction,
  lifecycleTone,
  siteLifecycleMenuActions,
} from "./siteLifecyclePresentation";
import type { SiteRecordMenuAction } from "./siteRecordMenu";

type Admin = typeof adminSummarySchema._output;
type Domain = typeof siteDomainRecordSchema._output;
type SettingsSite = Pick<
  SiteRecord,
  | "displayName"
  | "coupleNames"
  | "eventDate"
  | "lifecycle"
  | "publicationState"
  | "publicUrl"
  | "termStartsOn"
  | "termEndsOn"
> &
  Partial<
    Pick<SiteRecord, "repositorySlug" | "trustedOrigins" | "reviewApprovedAt">
  >;
export type GeneratedCoupleAccess = { userId: string; url: string };

const tabs = [
  ["data", "Dados do casamento"],
  ["dates", "Datas e vigência"],
  ["publication", "Publicação"],
  ["address", "Endereço do site"],
  ["access", "Acessos do casal"],
] as const;
const primary =
  "min-h-12 rounded-[10px] bg-admin-terracotta px-6 text-[15px] font-bold text-white hover:bg-admin-terracotta-deep";
const outline =
  "min-h-12 rounded-[10px] border-admin-line-strong px-6 text-[15px] font-semibold text-admin-graphite";
const textLink =
  "h-auto p-0 text-[15px] font-semibold text-admin-terracotta-deep underline underline-offset-4";
const card = `${adminStyles.surface} grid min-w-0 gap-3 px-[22px] py-5`;
const title =
  "m-0 font-admin-display text-[22px] font-normal text-admin-graphite";
// The panel body styles every h3 as a large display heading; card headings
// override its size, and plain headings also return to body type.
const cardTitle = "m-0 font-admin-display text-xl! font-normal text-admin-ink";
const plainHeading =
  "m-0 font-sans! text-[15px]! font-semibold! leading-normal! tracking-normal! text-admin-graphite";
const sectionIntro = "m-0 text-sm text-admin-muted";
const publicationTone: Record<string, "success" | "pending" | "neutral"> = {
  PUBLISHED: "success",
  PLACEHOLDER: "pending",
  UNPUBLISHED: "neutral",
};
const publicationStates = [
  ["UNPUBLISHED", "O site ainda não foi conferido no ar."],
  ["PUBLISHED", "O site está no ar e foi conferido."],
  [
    "PLACEHOLDER",
    "O endereço mostra uma página neutra, por exemplo quando o casamento está inativo.",
  ],
] as const;
const publicationSteps = [
  [
    "A equipe Entrelaços publica o site",
    "O deploy é feito manualmente pela equipe. Nada muda na hospedagem a partir deste painel.",
  ],
  [
    "Confira o site no ar",
    "Abra o endereço público e confira se as páginas, os presentes e a confirmação estão certos.",
  ],
  [
    "Registre a publicação",
    "Clique em “Registrar publicação” e escolha a situação. Esta ação não altera a hospedagem.",
  ],
] as const;
const lifecycleHeadline: Record<SiteRecord["lifecycle"], string> = {
  DRAFT: "Casamento em rascunho",
  IN_REVIEW: "Casamento em revisão",
  ACTIVE: "Casamento ativo",
  INACTIVE: "Casamento inativo",
};

export function SiteSettingsView({
  site,
  admins,
  domains,
  labels,
  pending,
  onEditRecord,
  onLifecycleAction,
  onAddAdmin,
  onAdminAction,
  onAddDomain,
  onEditDomain,
  onSaveAddress,
  generated,
  onDismissGenerated,
}: {
  site: SettingsSite;
  admins: Admin[];
  domains: Domain[];
  labels: Record<string, string>;
  pending: boolean;
  onEditRecord: (action: SiteRecordMenuAction) => void;
  onLifecycleAction: (action: LifecycleAction) => void;
  onAddAdmin: () => void;
  onAdminAction: (action: string, admin: Admin) => void;
  onAddDomain: () => void;
  onEditDomain: (domain: Domain) => void;
  onSaveAddress: (value: SiteUpdateInput) => Promise<boolean>;
  generated: GeneratedCoupleAccess | null;
  onDismissGenerated: () => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("data");
  const [replaceLink, setReplaceLink] = useState<string | null>(null);
  const [addressError, setAddressError] = useState("");
  const [originError, setOriginError] = useState("");
  // A link generated during an earlier visit must not reappear when the
  // settings view is mounted again, including through the ?tab=access entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once on mount.
  useEffect(() => {
    onDismissGenerated();
    if (new URLSearchParams(window.location.search).get("tab") === "access")
      setTab("access");
  }, []);
  function selectTab(next: typeof tab) {
    if (tab !== next) {
      setReplaceLink(null);
      onDismissGenerated();
      setTab(next);
    }
  }
  function saveAddress(
    event: FormEvent<HTMLFormElement>,
    field: "publicUrl" | "trustedOrigins",
  ) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get(field) ?? "");
    const setError = field === "publicUrl" ? setAddressError : setOriginError;
    const parsed =
      field === "publicUrl"
        ? validatePublicAddress(value)
        : validateTrustedOrigins(value);
    setError(parsed.error ?? "");
    if (parsed.value) void onSaveAddress(parsed.value);
  }
  const days = daysUntilWedding(site.eventDate, new Date());
  const weekday = formatBrazilianWeekday(site.eventDate);
  const eventHint =
    days === 0
      ? `${weekday} · é hoje.`
      : days === 1
        ? `${weekday} · falta 1 dia.`
        : days > 1
          ? `${weekday} · faltam ${days} dias.`
          : `${weekday}.`;
  const data = [
    {
      label: "Nome do casamento",
      value: site.displayName,
      action: "profile",
      hint: "Aparece no painel e na lista de casamentos.",
    },
    {
      label: "Casal",
      value: site.coupleNames.join(" e "),
      action: "profile",
      hint: "Os dois nomes, na ordem em que aparecem no site.",
    },
    {
      label: "Data do casamento",
      value: formatBrazilianDate(site.eventDate),
      action: "dates",
      hint: eventHint,
    },
    {
      label: "Endereço público",
      value: site.publicUrl
        ? publicUrlHostname(site.publicUrl)
        : "Site não vinculado",
      action: "address",
      hint: site.publicUrl ?? "Vincule o endereço quando o site estiver no ar.",
    },
  ] as const;
  const term =
    site.termStartsOn && site.termEndsOn
      ? `${formatBrazilianDate(site.termStartsOn)} a ${formatBrazilianDate(site.termEndsOn)}`
      : null;
  const lifecycleActions = siteLifecycleMenuActions(
    site.lifecycle,
    Boolean(site.termStartsOn || site.termEndsOn),
  );
  // The next review step leads the strip; the rest stays in the menu.
  const nextLifecycleAction = lifecycleActions.find(
    (item) => item.id === "review/start" || item.id === "review/approve",
  );
  const lifecycleDescription =
    site.lifecycle === "DRAFT"
      ? "Confira o cadastro antes de enviar o casamento para revisão."
      : site.lifecycle === "IN_REVIEW"
        ? "Pronto para conferência e aprovação."
        : site.lifecycle === "INACTIVE"
          ? "Os dados estão preservados. A publicação é conferida separadamente."
          : term
            ? `Vigência de ${term}. A publicação é conferida separadamente.`
            : "Vigência ainda não definida. Aprove para iniciar a vigência.";
  const approvedOn = site.reviewApprovedAt
    ? new Date(site.reviewApprovedAt).toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : null;

  return (
    <>
      <section
        aria-label="Situação do casamento"
        className={`${adminStyles.surface} flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] py-3 pr-3.5 pl-[18px]`}
      >
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[13px] font-semibold text-admin-muted">
            Situação
          </span>
          <ToneBadge tone={lifecycleTone[site.lifecycle]}>
            {labels[site.lifecycle]}
          </ToneBadge>
        </div>
        <span
          aria-hidden="true"
          className="hidden h-[22px] w-px bg-admin-line sm:block"
        />
        <div className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
          <strong className="text-sm text-admin-graphite">
            {lifecycleHeadline[site.lifecycle]}
          </strong>
          <span className="text-[13.5px] text-admin-muted">
            {lifecycleDescription}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {nextLifecycleAction && (
            <Button
              type="button"
              className={primary}
              disabled={pending}
              onClick={() => onLifecycleAction(nextLifecycleAction.id)}
            >
              {nextLifecycleAction.label}
            </Button>
          )}
          <OverflowMenu
            label="Ações da situação do casamento"
            disabled={pending}
            items={lifecycleActions.filter(
              (item) => item !== nextLifecycleAction,
            )}
            onSelect={(action) => onLifecycleAction(action as LifecycleAction)}
          />
        </div>
      </section>
      <fieldset
        aria-label="Seções das configurações"
        className="m-0 flex min-w-0 w-fit max-w-full flex-wrap gap-1 rounded-xl border border-admin-line bg-admin-surface p-1"
      >
        {tabs.map(([key, label]) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={tab === key ? "default" : "ghost"}
            aria-pressed={tab === key}
            disabled={pending}
            className={`h-[38px] px-4 text-sm font-semibold ${tab === key ? "" : "text-admin-muted"}`}
            onClick={() => selectTab(key)}
          >
            {label}
          </Button>
        ))}
      </fieldset>
      {tab === "data" && (
        <section className="grid gap-3.5">
          <div className="grid gap-1">
            <h2 className={title}>Dados do casamento</h2>
            <p className={sectionIntro}>
              Identificação e endereço público. Edite um item por vez.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {data.map((item) => (
              <div key={item.label} className={card}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-admin-body">
                    {item.label}
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    className={textLink}
                    aria-label={`Editar ${item.label.toLowerCase()}`}
                    disabled={pending}
                    onClick={() =>
                      item.action === "address"
                        ? selectTab("address")
                        : onEditRecord(item.action)
                    }
                  >
                    Editar
                  </Button>
                </div>
                <strong className="break-words text-[17px] text-admin-ink">
                  {item.value}
                </strong>
                <p className="m-0 break-words text-[13px] text-admin-muted">
                  {item.hint}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === "dates" && (
        <section className="grid gap-3.5">
          <div className="grid gap-1">
            <h2 className={title}>Datas e vigência</h2>
            <p className={sectionIntro}>Data do evento e período contratado.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className={card}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-admin-body">
                  Data do casamento
                </span>
                <Button
                  type="button"
                  variant="link"
                  className={textLink}
                  aria-label="Editar data do casamento"
                  disabled={pending}
                  onClick={() => onEditRecord("dates")}
                >
                  Editar
                </Button>
              </div>
              <strong className="text-[17px] text-admin-ink">
                {formatBrazilianDate(site.eventDate)}
              </strong>
              <p className="m-0 text-[13px] text-admin-muted">{eventHint}</p>
            </div>
            <div className={card}>
              <span className="text-[13px] font-medium text-admin-body">
                Aprovação
              </span>
              <strong className="text-[17px] text-admin-ink">
                {approvedOn
                  ? `Aprovado em ${approvedOn}`
                  : "Ainda não aprovado"}
              </strong>
              <p className="m-0 text-[13px] text-admin-muted">
                {approvedOn
                  ? "Registrada na aprovação da revisão. Não é editável."
                  : "A vigência começa quando a revisão é aprovada."}
              </p>
            </div>
          </div>
          <div className={card}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid gap-0.5">
                <h3 className={plainHeading}>Vigência</h3>
                <p className="m-0 text-[13px] text-admin-muted">
                  {term
                    ? `Período contratado: ${term}.`
                    : "Vigência ainda não definida."}
                </p>
              </div>
              <Button
                type="button"
                variant="link"
                className={textLink}
                aria-label="Editar vigência"
                disabled={pending}
                onClick={() => onEditRecord("dates")}
              >
                Editar
              </Button>
            </div>
            <p className="m-0 rounded-[10px] bg-admin-beige px-3 py-2.5 text-[13px] leading-normal text-admin-body">
              A aprovação inicia um ano de vigência. O vencimento não inativa o
              casamento automaticamente. O fim precisa ser igual ou posterior ao
              início.
            </p>
          </div>
        </section>
      )}
      {tab === "publication" && (
        <section className="grid gap-3.5">
          <div className="grid gap-1">
            <h2 className={title}>Publicação do site</h2>
            <p className={sectionIntro}>
              Última situação registrada para o site. A publicação é feita pela
              equipe Entrelaços.
            </p>
          </div>
          <div className={`${card} gap-3.5`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="grid min-w-0 flex-[1_1_18rem] gap-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className={cardTitle}>Publicação registrada</h3>
                  <ToneBadge
                    tone={publicationTone[site.publicationState] ?? "neutral"}
                  >
                    {labels[site.publicationState]}
                  </ToneBadge>
                </div>
                <p className="m-0 text-sm leading-normal text-admin-muted">
                  Atualize este registro após conferir o site no ar. A
                  publicação é realizada separadamente.
                </p>
              </div>
              <Button
                type="button"
                className={primary}
                disabled={pending}
                onClick={() => onEditRecord("publication")}
              >
                Registrar publicação
              </Button>
            </div>
            <div className="grid gap-3 border-t border-admin-line pt-3.5">
              <p className="m-0 text-[11px] font-bold uppercase tracking-[0.12em] text-admin-muted">
                Como funciona
              </p>
              <ol className="m-0 grid list-none gap-3 p-0">
                {publicationSteps.map(([step, detail], index) => (
                  <li key={step} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-admin-terracotta-wash text-xs font-bold text-admin-terracotta-ink"
                    >
                      {index + 1}
                    </span>
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="text-sm font-semibold text-admin-graphite">
                        {step}
                      </strong>
                      <span className="text-[13px] leading-normal text-admin-muted">
                        {detail}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className={`${card} gap-3.5`}>
            <div className="grid gap-1">
              <h3 className={plainHeading}>
                Situações que podem ser registradas
              </h3>
              <p className="m-0 text-[13px] text-admin-muted">
                Escolha uma delas em “Registrar publicação”.
              </p>
            </div>
            <dl className="m-0 grid gap-2.5">
              {publicationStates.map(([state, description]) => (
                <div
                  key={state}
                  className="grid items-center gap-x-3.5 gap-y-1 sm:grid-cols-[130px_minmax(0,1fr)]"
                >
                  <dt>
                    <ToneBadge tone={publicationTone[state]}>
                      {labels[state] ?? state}
                    </ToneBadge>
                  </dt>
                  <dd className="m-0 text-[13.5px] text-admin-body">
                    {description}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="m-0 rounded-[10px] bg-admin-beige px-3.5 py-2.5 text-[13px] leading-normal text-admin-body">
              A situação do casamento (Rascunho, Em revisão, Ativo ou Inativo)
              aparece na faixa acima e é independente da publicação. Reativar ou
              inativar o casamento não publica nem tira o site do ar.
            </p>
          </div>
        </section>
      )}
      {tab === "address" && (
        <section className="grid gap-3.5">
          <div className="grid gap-1">
            <h2 className={title}>Endereço do site</h2>
            <p className={sectionIntro}>
              Identificador do site, endereço público e endereços autorizados.
            </p>
          </div>
          <div className={card}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={plainHeading}>Identificador do site</h3>
              <ToneBadge tone="neutral">Somente leitura</ToneBadge>
            </div>
            <label
              htmlFor="site-repository-slug"
              className="grid gap-1.5 text-[13px] font-semibold text-admin-graphite"
            >
              Identificador
              <Input
                id="site-repository-slug"
                readOnly
                value={site.repositorySlug ?? ""}
                className="h-11 rounded-[10px] border-admin-line-strong bg-admin-beige"
              />
            </label>
            <p className="m-0 text-xs text-admin-muted">
              Definido na criação do site. Não pode ser alterado.
            </p>
          </div>
          <form
            className={card}
            noValidate
            onSubmit={(event) => saveAddress(event, "publicUrl")}
          >
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className={cardTitle}>Endereço público</h3>
                <StatusSignal tone={site.publicUrl ? "success" : "neutral"}>
                  {site.publicUrl ? "Site vinculado" : "Site não vinculado"}
                </StatusSignal>
              </div>
              {!site.publicUrl && (
                <p className="m-0 text-[13px] text-admin-muted">
                  Site não vinculado — informe o endereço quando o site estiver
                  no ar.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2.5">
              <label
                htmlFor="site-public-url"
                className="grid min-w-0 flex-[1_1_16rem] gap-1.5 text-[13px] font-semibold text-admin-graphite"
              >
                Endereço público
                <Input
                  id="site-public-url"
                  name="publicUrl"
                  type="url"
                  placeholder="https://"
                  defaultValue={site.publicUrl ?? ""}
                  className="h-11 rounded-[10px] border-admin-line-strong placeholder:font-normal placeholder:text-admin-muted"
                  aria-invalid={Boolean(addressError)}
                  aria-describedby="site-public-url-help"
                />
              </label>
              <Button type="submit" className={primary} disabled={pending}>
                Vincular endereço
              </Button>
            </div>
            <p
              id="site-public-url-help"
              className="m-0 text-xs text-admin-muted"
            >
              Use o endereço completo com https://, sem caminho depois da barra.
            </p>
            {addressError && (
              <p role="alert" className={adminStyles.authError}>
                {addressError}
              </p>
            )}
          </form>
          <form
            className={card}
            noValidate
            onSubmit={(event) => saveAddress(event, "trustedOrigins")}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid min-w-0 flex-[1_1_18rem] gap-1">
                <h3 className={plainHeading}>
                  Configuração avançada de endereços
                </h3>
                <p className="m-0 text-[13px] text-admin-muted">
                  Informe os endereços completos autorizados a enviar
                  confirmações e mensagens pelo site. Use um por linha.
                </p>
              </div>
              <ToneBadge tone="neutral">Opcional</ToneBadge>
            </div>
            <label
              htmlFor="site-trusted-origins"
              className="grid gap-1.5 text-[13px] font-semibold text-admin-graphite"
            >
              Endereços autorizados
              <Textarea
                id="site-trusted-origins"
                name="trustedOrigins"
                rows={3}
                placeholder="https://casamento.exemplo.com"
                defaultValue={site.trustedOrigins?.join("\n") ?? ""}
                className="rounded-[10px] border-admin-line-strong placeholder:font-normal placeholder:text-admin-muted"
                aria-invalid={Boolean(originError)}
                aria-describedby="site-origins-help"
              />
            </label>
            <p id="site-origins-help" className="m-0 text-xs text-admin-muted">
              Até 20 endereços. Cada um deve ser só a origem — https:// e o
              domínio, sem caminho depois da barra.
            </p>
            {originError && (
              <p role="alert" className={adminStyles.authError}>
                {originError}
              </p>
            )}
            <Button
              type="submit"
              variant="outline"
              className={`${outline} w-fit`}
              disabled={pending}
            >
              Salvar endereços
            </Button>
          </form>
          <details className={`group ${adminStyles.surface}`}>
            <summary className="flex cursor-pointer list-none items-center gap-4 rounded-2xl p-6 outline-offset-4 marker:content-none">
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-base font-semibold text-admin-ink">
                  Domínios
                </h2>
                <p className="mb-0 mt-1 text-sm leading-relaxed text-admin-muted">
                  {domains.length}{" "}
                  {domains.length === 1
                    ? "endereço registrado"
                    : "endereços registrados"}
                  . Configuração e renovação.
                </p>
              </div>
              <ChevronDown
                className="size-4 shrink-0 text-admin-muted transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="grid gap-4 border-t border-admin-line p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="m-0 text-sm text-admin-muted">
                  Configuração, hospedagem e renovação são feitas separadamente.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={onAddDomain}
                >
                  Registrar domínio
                </Button>
              </div>
              {domains.length === 0 ? (
                <p className="m-0 rounded-xl bg-admin-canvas p-4 text-sm text-admin-muted">
                  Nenhum domínio registrado. Registre os endereços para
                  acompanhar a configuração e a renovação.
                </p>
              ) : (
                <Table className="w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endereço</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead>Renovação</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {domains.map((domain) => (
                      <TableRow
                        className="border-b border-admin-line"
                        key={`${domain.id}-${domain.updatedAt}`}
                      >
                        <TableCell className="whitespace-normal">
                          <span className="block break-all font-medium">
                            {domain.hostname}
                          </span>
                          {domain.isPrimary && (
                            <span className="mt-1 block text-xs text-admin-muted">
                              Principal
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <ToneBadge tone="neutral">
                            {labels[domain.state]}
                          </ToneBadge>
                        </TableCell>
                        <TableCell>
                          {domain.expiresOn
                            ? formatBrazilianDate(domain.expiresOn)
                            : "Não informada"}
                        </TableCell>
                        <TableCell className="text-right">
                          <OverflowMenu
                            label={`Ações de ${domain.hostname}`}
                            disabled={pending}
                            items={[{ id: "edit", label: "Editar domínio" }]}
                            onSelect={() => onEditDomain(domain)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </details>
        </section>
      )}
      {tab === "access" && (
        <section className="grid gap-3.5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid min-w-0 flex-[1_1_20rem] gap-1">
              <h2 className={title}>Acessos do casal</h2>
              <p className={sectionIntro}>
                Quem do casal administra o painel. Links de acesso valem por 24
                horas, podem ser usados uma vez e só aparecem ao gerar.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className={outline}
              disabled={pending}
              onClick={onAddAdmin}
            >
              Adicionar pessoa
            </Button>
          </div>
          {!site.publicUrl && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-admin-line bg-admin-canvas py-2 pr-3 pl-[18px]">
              <StatusSignal tone="neutral">Site não vinculado</StatusSignal>
              <span
                aria-hidden="true"
                className="hidden h-[18px] w-px bg-admin-line sm:block"
              />
              <p className="m-0 min-w-0 flex-[1_1_14rem] text-[13.5px] text-admin-body">
                Vincule o endereço público quando o site estiver no ar.
              </p>
              <Button
                type="button"
                variant="link"
                className={textLink}
                onClick={() => selectTab("address")}
              >
                Ir para Endereço do site
              </Button>
            </div>
          )}
          <div
            className={`${adminStyles.surface} overflow-hidden rounded-[18px]`}
          >
            <div className="flex items-center justify-between gap-2 px-[22px] py-4">
              <h3 className={cardTitle}>Pessoas cadastradas</h3>
              <span className="text-[13px] text-admin-muted">
                {admins.length === 1 ? "1 pessoa" : `${admins.length} pessoas`}
              </span>
            </div>
            {admins.length ? (
              <ul className="m-0 list-none p-0">
                {admins.map((admin) => (
                  <li
                    key={admin.userId}
                    className="grid gap-3 border-t border-admin-line px-[22px] py-4"
                  >
                    <div
                      data-slot="couple-access-row"
                      className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-3 lg:grid-cols-[40px_minmax(0,1fr)_180px_392px]"
                    >
                      <span
                        data-slot="person-avatar"
                        aria-hidden="true"
                        className="flex size-10 items-center justify-center rounded-full border border-admin-terracotta bg-admin-terracotta-wash text-[12.5px] font-extrabold tracking-[0.04em] text-admin-terracotta-deep"
                      >
                        {getInitials(admin.name)}
                      </span>
                      <div className="grid min-w-0 gap-[3px]">
                        <strong className="break-words text-[15px] font-semibold text-admin-ink">
                          {admin.name}
                        </strong>
                        <p className="m-0 break-all text-[13px] text-admin-muted">
                          {admin.email}
                        </p>
                      </div>
                      <div
                        data-slot="access-status"
                        className="col-start-2 grid min-w-0 gap-[5px] lg:col-start-auto"
                      >
                        <ToneBadge
                          tone={
                            admin.pendingAccess
                              ? "pending"
                              : admin.state === "ACTIVE"
                                ? "success"
                                : "neutral"
                          }
                        >
                          {generated?.userId === admin.userId
                            ? "Link gerado agora"
                            : admin.pendingAccess
                              ? "Link ativo"
                              : admin.state === "ACTIVE"
                                ? "Acesso ativado"
                                : labels[admin.state]}
                        </ToneBadge>
                        {admin.pendingAccess && (
                          <time
                            dateTime={admin.pendingAccess.expiresAt}
                            className="text-[12.5px] text-admin-muted"
                          >
                            Expira em{" "}
                            {new Date(
                              admin.pendingAccess.expiresAt,
                            ).toLocaleString("pt-BR", {
                              timeZone: "America/Sao_Paulo",
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </time>
                        )}
                      </div>
                      <div
                        data-slot="access-actions"
                        className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 lg:col-start-auto lg:justify-end"
                      >
                        {admin.state !== "DISABLED" && (
                          <>
                            {generated?.userId !== admin.userId && (
                              <Button
                                type="button"
                                variant="outline"
                                className={`${outline} max-sm:px-4`}
                                disabled={pending}
                                onClick={() =>
                                  admin.pendingAccess
                                    ? setReplaceLink(admin.userId)
                                    : onAdminAction("issue-access", admin)
                                }
                              >
                                {admin.pendingAccess
                                  ? "Gerar novo link"
                                  : admin.state === "ACTIVE"
                                    ? "Gerar link de recuperação"
                                    : "Gerar link de acesso"}
                              </Button>
                            )}
                            {admin.pendingAccess && (
                              <Button
                                type="button"
                                disabled={pending}
                                className={`${adminStyles.dangerButton} max-sm:px-4`}
                                onClick={() =>
                                  onAdminAction("revoke-access", admin)
                                }
                              >
                                Revogar link
                              </Button>
                            )}
                            <OverflowMenu
                              label={`Ações de ${admin.name}`}
                              disabled={pending}
                              items={[
                                {
                                  id: "disable-access",
                                  label: "Desativar acesso",
                                  variant: "destructive",
                                },
                              ]}
                              onSelect={(action) =>
                                onAdminAction(action, admin)
                              }
                            />
                          </>
                        )}
                      </div>
                    </div>
                    {replaceLink === admin.userId && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-admin-pending-wash py-2.5 pr-2.5 pl-3.5 text-admin-pending-ink lg:ml-[54px]">
                        <div className="grid min-w-0 gap-0.5">
                          <strong className="text-[13.5px] font-semibold">
                            Gerar um novo link para {admin.name}?
                          </strong>
                          <p className="m-0 text-[13px]">
                            O link anterior deixará de funcionar imediatamente.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            variant="link"
                            className={textLink}
                            onClick={() => setReplaceLink(null)}
                          >
                            Cancelar
                          </Button>
                          <Button
                            type="button"
                            className={primary}
                            disabled={pending}
                            onClick={() => {
                              setReplaceLink(null);
                              onAdminAction("issue-access", admin);
                            }}
                          >
                            Confirmar novo link
                          </Button>
                        </div>
                      </div>
                    )}
                    {generated?.userId === admin.userId && (
                      <div className="min-w-0 lg:ml-[54px]">
                        <GeneratedAccessLink
                          name={admin.name}
                          email={admin.email}
                          url={generated.url}
                          onDismiss={onDismissGenerated}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 border-t border-admin-line px-[22px] py-5 text-sm text-admin-muted">
                Nenhuma pessoa do casal cadastrada.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function publicUrlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
