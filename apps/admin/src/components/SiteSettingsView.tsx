import type {
  adminSummarySchema,
  SiteRecord,
  SiteUpdateInput,
  siteDomainRecordSchema,
} from "@entrelacos/contracts";
import {
  Badge,
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
import { formatBrazilianDate } from "./brazilianDate";
import { GeneratedAccessLink } from "./GeneratedAccessLink";
import { OverflowMenu } from "./OverflowMenu";
import {
  validatePublicAddress,
  validateTrustedOrigins,
} from "./ownerSiteAddresses";
import { StatusSignal } from "./StatusSignal";
import {
  type LifecycleAction,
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
  Partial<Pick<SiteRecord, "repositorySlug" | "trustedOrigins">>;
export type GeneratedCoupleAccess = { userId: string; url: string };

const tabs = [
  ["data", "Dados do casamento"],
  ["dates", "Datas e vigência"],
  ["publication", "Publicação"],
  ["address", "Endereço do site"],
  ["access", "Acessos do casal"],
] as const;
const primary = "bg-admin-terracotta text-white hover:bg-admin-terracotta-deep";
const card = `${adminStyles.surface} grid min-w-0 gap-3 p-5`;
const title = "m-0 font-admin-display text-2xl font-normal";

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
      hint: "Data do evento.",
    },
    {
      label: "Endereço público",
      value: site.publicUrl ?? "Site não vinculado",
      action: "address",
      hint: "Vincule o endereço quando o site estiver no ar.",
    },
  ] as const;
  const term =
    site.termStartsOn && site.termEndsOn
      ? `${formatBrazilianDate(site.termStartsOn)} a ${formatBrazilianDate(site.termEndsOn)}`
      : "Vigência ainda não definida";

  return (
    <>
      <div
        className={`${adminStyles.surface} flex flex-wrap items-center justify-between gap-3 px-5 py-3.5`}
      >
        <div className="flex flex-wrap items-center gap-2.5 text-sm">
          <span className="font-semibold text-admin-muted">
            Situação do casamento
          </span>
          <Badge
            variant="secondary"
            className={
              site.lifecycle === "ACTIVE"
                ? "bg-admin-success-wash text-admin-success-ink"
                : "bg-admin-beige"
            }
          >
            {labels[site.lifecycle]}
          </Badge>
          <span className="text-admin-muted">
            {site.lifecycle === "DRAFT"
              ? "Confira o cadastro antes de enviar para revisão."
              : site.lifecycle === "IN_REVIEW"
                ? "Pronto para conferência e aprovação."
                : site.lifecycle === "INACTIVE"
                  ? "Casamento inativo. Os dados estão preservados."
                  : `Casamento ativo · ${term}`}
          </span>
        </div>
        <OverflowMenu
          label="Ações da situação do casamento"
          disabled={pending}
          items={siteLifecycleMenuActions(
            site.lifecycle,
            Boolean(site.termStartsOn || site.termEndsOn),
          )}
          onSelect={(action) => onLifecycleAction(action as LifecycleAction)}
        />
      </div>
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
            onClick={() => selectTab(key)}
          >
            {label}
          </Button>
        ))}
      </fieldset>
      {tab === "data" && (
        <section className="grid gap-3">
          <h2 className={title}>Dados do casamento</h2>
          <p className="m-0 text-sm text-admin-muted">
            Identificação e endereço público do casamento.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {data.map((item) => (
              <div key={item.label} className={card}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-admin-muted">{item.label}</span>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-admin-terracotta-deep"
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
                <strong className="break-words">{item.value}</strong>
                <p className="m-0 text-xs text-admin-muted">{item.hint}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === "dates" && (
        <section className="grid gap-3">
          <h2 className={title}>Datas e vigência</h2>
          <div className={card}>
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-admin-muted">Data do casamento</dt>
                <dd className="m-0 font-semibold">
                  {formatBrazilianDate(site.eventDate)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-admin-muted">Vigência</dt>
                <dd className="m-0 font-semibold">{term}</dd>
              </div>
            </dl>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={pending}
              onClick={() => onEditRecord("dates")}
            >
              Editar datas
            </Button>
          </div>
        </section>
      )}
      {tab === "publication" && (
        <section className="grid gap-3">
          <h2 className={title}>Publicação do site</h2>
          <p className="m-0 text-sm text-admin-muted">
            Última situação registrada para o site. A publicação é feita pela
            equipe Entrelaços.
          </p>
          <div className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="m-0 text-xl">Publicação registrada</h3>
                  <Badge variant="secondary">
                    {labels[site.publicationState]}
                  </Badge>
                </div>
                <p className="m-0 text-sm text-admin-muted">
                  Depois do deploy manual, confira o site no ar e registre a
                  publicação aqui. Esta ação não altera a hospedagem.
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
            <ol className="m-0 grid list-decimal gap-2 border-t border-admin-line pl-5 pt-4 text-sm text-admin-body">
              <li>Faça o deploy manual do site.</li>
              <li>Abra o endereço público e confira o site no ar.</li>
              <li>Registre aqui a situação encontrada.</li>
            </ol>
          </div>
          <div className={card}>
            <p className="m-0 font-semibold">
              Situações que podem ser registradas
            </p>
            <dl className="m-0 grid gap-2 text-sm">
              <div>
                <dt className="font-semibold">{labels.UNPUBLISHED}</dt>
                <dd className="m-0 text-admin-muted">
                  O site ainda não foi conferido no ar.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">{labels.PUBLISHED}</dt>
                <dd className="m-0 text-admin-muted">
                  O site está no ar e foi conferido.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">{labels.PLACEHOLDER}</dt>
                <dd className="m-0 text-admin-muted">
                  O endereço mostra uma página neutra.
                </dd>
              </div>
            </dl>
          </div>
        </section>
      )}
      {tab === "address" && (
        <section className="grid gap-3">
          <h2 className={title}>Endereço do site</h2>
          <div className={card}>
            <div className="flex flex-wrap items-center gap-2">
              <strong>Identificador do site</strong>
              <Badge variant="secondary">Somente leitura</Badge>
            </div>
            <label
              htmlFor="site-repository-slug"
              className="grid gap-1.5 text-sm"
            >
              Identificador
              <Input
                id="site-repository-slug"
                readOnly
                value={site.repositorySlug ?? ""}
                className="bg-admin-beige"
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
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="m-0 text-xl">Endereço público</h3>
              <StatusSignal tone={site.publicUrl ? "success" : "neutral"}>
                {site.publicUrl ? "Site vinculado" : "Site não vinculado"}
              </StatusSignal>
            </div>
            <div className="flex flex-wrap items-end gap-2.5">
              <label
                htmlFor="site-public-url"
                className="grid min-w-0 flex-[1_1_16rem] gap-1.5 text-sm font-medium"
              >
                Endereço público
                <Input
                  id="site-public-url"
                  name="publicUrl"
                  type="url"
                  defaultValue={site.publicUrl ?? ""}
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
            <strong>Configuração avançada de endereços</strong>
            <p className="m-0 text-sm text-admin-muted">
              Informe os endereços autorizados a enviar confirmações e mensagens
              pelo site.
            </p>
            <label
              htmlFor="site-trusted-origins"
              className="grid gap-1.5 text-sm font-medium"
            >
              Endereços autorizados
              <Textarea
                id="site-trusted-origins"
                name="trustedOrigins"
                rows={3}
                defaultValue={site.trustedOrigins?.join("\n") ?? ""}
                aria-invalid={Boolean(originError)}
                aria-describedby="site-origins-help"
              />
            </label>
            <p id="site-origins-help" className="m-0 text-xs text-admin-muted">
              Até 20 endereços. Use uma origem por linha, sem caminho ou barra
              final.
            </p>
            {originError && (
              <p role="alert" className={adminStyles.authError}>
                {originError}
              </p>
            )}
            <Button
              type="submit"
              variant="outline"
              className="w-fit"
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
                          <Badge variant="outline">
                            {labels[domain.state]}
                          </Badge>
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
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <h2 className={title}>Acessos do casal</h2>
              <p className="m-0 text-sm text-admin-muted">
                Links de acesso valem por 24 horas, podem ser usados uma vez e
                só aparecem ao gerar.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onAddAdmin}
            >
              Adicionar pessoa
            </Button>
          </div>
          {!site.publicUrl && (
            <div
              className={`${card} flex flex-wrap items-center justify-between`}
            >
              <StatusSignal tone="neutral">Site não vinculado</StatusSignal>
              <Button
                type="button"
                variant="link"
                onClick={() => selectTab("address")}
              >
                Ir para Endereço do site
              </Button>
            </div>
          )}
          <div className={`${adminStyles.surface} overflow-hidden`}>
            <div className="flex items-center justify-between gap-2 border-b border-admin-line p-5">
              <h3 className="m-0 text-xl">Pessoas cadastradas</h3>
              <span className="text-sm text-admin-muted">{admins.length}</span>
            </div>
            {admins.length ? (
              <ul className="m-0 list-none divide-y divide-admin-line p-0">
                {admins.map((admin) => (
                  <li key={admin.userId} className="grid gap-3 p-5">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <strong className="break-words">{admin.name}</strong>
                        <p className="m-0 break-all text-sm text-admin-muted">
                          {admin.email}
                        </p>
                      </div>
                      <div className="grid gap-1">
                        <Badge
                          variant="secondary"
                          className={
                            admin.pendingAccess
                              ? "bg-admin-pending-wash text-admin-pending-ink"
                              : admin.state === "ACTIVE"
                                ? "bg-admin-success-wash text-admin-success-ink"
                                : "bg-admin-beige"
                          }
                        >
                          {generated?.userId === admin.userId
                            ? "Link gerado agora"
                            : admin.pendingAccess
                              ? "Link ativo"
                              : admin.state === "ACTIVE"
                                ? "Acesso ativado"
                                : labels[admin.state]}
                        </Badge>
                        {admin.pendingAccess && (
                          <time
                            dateTime={admin.pendingAccess.expiresAt}
                            className="text-xs text-admin-muted"
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
                      {admin.state !== "DISABLED" && (
                        <div className="flex flex-wrap gap-2">
                          {generated?.userId !== admin.userId && (
                            <Button
                              type="button"
                              variant="outline"
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
                              className={adminStyles.dangerButton}
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
                            onSelect={(action) => onAdminAction(action, admin)}
                          />
                        </div>
                      )}
                    </div>
                    {replaceLink === admin.userId && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-admin-pending-wash p-3 text-sm text-admin-pending-ink">
                        <p className="m-0">
                          O link anterior deixará de funcionar imediatamente.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="ghost"
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
                      <GeneratedAccessLink
                        name={admin.name}
                        email={admin.email}
                        url={generated.url}
                        onDismiss={onDismissGenerated}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 p-5 text-sm text-admin-muted">
                Nenhuma pessoa do casal cadastrada.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
