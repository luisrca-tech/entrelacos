import type {
  adminSummarySchema,
  SiteRecord,
  siteDomainRecordSchema,
} from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import type { SiteArea } from "./adminNavigation";
import { GuestGroupsSection } from "./GuestGroupsSection";
import { MessagesSection } from "./MessagesSection";
import { OverflowMenu } from "./OverflowMenu";
import { RsvpSection } from "./RsvpSection";
import { SmsUsageSection } from "./SmsUsageSection";
import { siteAdminMenuActions } from "./siteAdminMenu";
import { publicSiteHandoffUrl, subscribeToPanelOrigin } from "./sitePublicUrl";
import { getWorkspaceHeading } from "./siteWorkspaceHeading";

export type { SiteArea } from "./adminNavigation";

const labels: Record<string, string> = {
  DRAFT: "Rascunho",
  IN_REVIEW: "Em revisão",
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  UNPUBLISHED: "Não publicado",
  PUBLISHED: "Publicado",
  PLACEHOLDER: "Página neutra",
  NONE: "Não configurado",
  PENDING: "Pendente",
  DISABLED: "Desativado",
};

type InternalField =
  | "repositorySlug"
  | "provisioningKey"
  | "trustedOrigins"
  | "reviewApprovedAt"
  | "createdAt"
  | "updatedAt";
type SiteView = Omit<SiteRecord, InternalField> &
  Partial<Pick<SiteRecord, InternalField>>;
type Admin = typeof adminSummarySchema._output;
type Domain = typeof siteDomainRecordSchema._output;
type LifecycleAction =
  | "review/start"
  | "review/approve"
  | "reactivate"
  | "deactivate";

export function SiteWorkspace({
  siteId,
  owner,
  area = "overview",
  onSiteName,
}: {
  siteId: string;
  owner: boolean;
  area?: SiteArea;
  onSiteName?: (name: string) => void;
}) {
  const [site, setSite] = useState<SiteView | null>(null);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState("");
  const [fatal, setFatal] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [accessLink, setAccessLink] = useState("");
  const [lifecycleAction, setLifecycleAction] =
    useState<LifecycleAction | null>(null);
  const [adminToDisable, setAdminToDisable] = useState<Admin | null>(null);
  const [settingsDialog, setSettingsDialog] = useState<
    | "profile"
    | "dates"
    | "publication"
    | "admin"
    | "domain"
    | "domain-edit"
    | null
  >(null);
  const [domainToEdit, setDomainToEdit] = useState<Domain | null>(null);
  const [publicationState, setPublicationState] =
    useState<SiteView["publicationState"]>("UNPUBLISHED");
  const [domainState, setDomainState] = useState<Domain["state"]>("NONE");
  const [domainPrimary, setDomainPrimary] = useState(false);
  const [domainExpiry, setDomainExpiry] = useState("");
  const panelOrigin = useSyncExternalStore(
    subscribeToPanelOrigin,
    () => window.location.origin,
    () => "",
  );
  const base = `/v1/owner/sites/${encodeURIComponent(siteId)}`;

  const load = useCallback(async () => {
    const result = await apiRequest<{ site: SiteView }>(
      owner ? base : `/v1/sites/${encodeURIComponent(siteId)}`,
    );
    setSite(result.site);
    onSiteName?.(result.site.displayName);
    // Settings data is owner-scoped and never requested for SITE_ADMIN.
    if (owner && area === "settings") {
      const [users, names] = await Promise.all([
        apiRequest<{ admins: Admin[] }>(`${base}/admins`),
        apiRequest<{ domains: Domain[] }>(`${base}/domains`),
      ]);
      setAdmins(users.admins);
      setDomains(names.domains);
    }
  }, [area, base, onSiteName, owner, siteId]);

  useEffect(() => {
    setFatal(false);
    void load().catch((cause) => {
      setFatal(true);
      setError(
        cause instanceof ApiError && cause.status === 404
          ? "Acesso negado ou casamento não encontrado."
          : cause instanceof Error
            ? cause.message
            : "Não foi possível carregar o casamento.",
      );
    });
  }, [load]);

  async function mutate(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<boolean> {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(path, { method, body });
      await load();
      setNotice("Alteração salva.");
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Não foi possível salvar.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submit(
    event: FormEvent<HTMLFormElement>,
    path: string,
    body: (form: FormData) => unknown,
    method = "POST",
  ): Promise<boolean> {
    event.preventDefault();
    return mutate(path, body(new FormData(event.currentTarget)), method);
  }

  async function issue(admin: Admin, purpose: "ACTIVATION" | "RECOVERY") {
    setPending(true);
    setError("");
    setAccessLink("");
    try {
      const result = await apiRequest<{ token: string }>(
        `/v1/owner/admins/${admin.userId}/access`,
        { method: "POST", body: { userId: admin.userId, purpose } },
      );
      setAccessLink(
        `${window.location.origin}/${purpose === "ACTIVATION" ? "activate" : "recover"}#token=${result.token}`,
      );
      setNotice(
        `Link para ${admin.email}. Entregue em particular. Válido por 24 horas; substitui o link anterior da mesma finalidade.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível gerar o link.",
      );
    } finally {
      setPending(false);
    }
  }

  function handleAdminMenuAction(action: string, admin: Admin) {
    if (action === "issue-access") {
      void issue(admin, admin.state === "PENDING" ? "ACTIVATION" : "RECOVERY");
      return;
    }
    if (action === "revoke-access") {
      setAccessLink("");
      void mutate(`/v1/owner/admins/${admin.userId}/access/revoke`, {
        userId: admin.userId,
        purpose: admin.state === "PENDING" ? "ACTIVATION" : "RECOVERY",
      });
      return;
    }
    setAdminToDisable(admin);
  }

  function openDomainEdit(domain: Domain) {
    setDomainToEdit(domain);
    setDomainState(domain.state);
    setDomainPrimary(domain.isPrimary);
    setDomainExpiry(domain.expiresOn ?? "");
    setSettingsDialog("domain-edit");
  }

  function closeSettingsDialog() {
    setSettingsDialog(null);
    setDomainToEdit(null);
    setError("");
  }

  async function submitDates(event: FormEvent<HTMLFormElement>) {
    const values = new FormData(event.currentTarget);
    const missingDate =
      !values.get("date") ||
      (site?.termStartsOn && (!values.get("start") || !values.get("end")));
    if (missingDate) {
      event.preventDefault();
      setError("Informe todas as datas obrigatórias.");
      return;
    }
    const saved = await submit(
      event,
      `${base}/dates`,
      (form) => ({
        eventDate: form.get("date"),
        ...(site?.termStartsOn
          ? {
              termStartsOn: form.get("start"),
              termEndsOn: form.get("end"),
            }
          : {}),
      }),
      "PATCH",
    );
    if (saved) closeSettingsDialog();
  }

  async function saveDomainEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!domainToEdit) return;
    const saved = await mutate(
      `${base}/domains/${domainToEdit.id}`,
      {
        state: domainState,
        isPrimary: domainPrimary,
        expiresOn: domainExpiry || null,
      },
      "PATCH",
    );
    if (saved) closeSettingsDialog();
  }

  if (fatal)
    return (
      <section className="panel-section">
        <h1>Acesso indisponível</h1>
        <p role="alert">{error}</p>
        <a href="/login">Entrar novamente</a>
      </section>
    );
  if (!site) return <p role="status">Carregando casamento…</p>;

  const inactive = site.lifecycle === "INACTIVE";
  const heading = getWorkspaceHeading({
    area,
    owner,
    lifecycle: site.lifecycle,
  });
  const lifecycleLabel = lifecycleAction
    ? {
        "review/start": "Enviar este casamento para revisão?",
        "review/approve": "Aprovar este casamento e iniciar a vigência?",
        reactivate: "Reativar este casamento?",
        deactivate: "Inativar este casamento?",
      }[lifecycleAction]
    : "";

  return (
    <>
      <section className="panel-heading workspace-heading">
        {heading.showBackLink && (
          <Link className="workspace-back" to="/">
            ← Todos os casamentos
          </Link>
        )}
        <div className="workspace-heading-row">
          <div>
            <h1>{heading.title}</h1>
            <p className="workspace-identity">{site.displayName}</p>
            <p className="lede">{heading.lede}</p>
          </div>
          <div className="workspace-heading-actions">
            {site.publicUrl && (
              <a
                className="primary-action"
                href={publicSiteHandoffUrl(site.publicUrl, panelOrigin)}
              >
                Ir para o site
              </a>
            )}
            {heading.showLifecycleBadge && (
              <Badge
                variant={site.lifecycle === "ACTIVE" ? "default" : "secondary"}
              >
                {labels[site.lifecycle]}
              </Badge>
            )}
          </div>
        </div>
      </section>
      {error && !settingsDialog && (
        <p role="alert">
          {error} <a href="/login">Login</a>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {accessLink && (
        <Card className="panel-section">
          <CardContent>
            <label htmlFor="site-access-link">
              Link de acesso
              <Input
                id="site-access-link"
                className="access-link"
                value={accessLink}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAccessLink("");
                setNotice("");
              }}
            >
              Ocultar link
            </Button>
          </CardContent>
        </Card>
      )}
      {inactive && (
        <p className="notice">
          Casamento inativo. Os dados estão preservados e a consulta permanece
          disponível.
          {owner
            ? " A publicação da página neutra em todos os endereços é uma etapa manual separada."
            : " Alterações estão indisponíveis enquanto o site estiver inativo."}
        </p>
      )}

      {area === "overview" && (
        <section className="workspace-area" data-area="overview">
          <Card className="panel-section facts" aria-label="Status e datas">
            <CardContent>
              <div>
                <strong>Casamento</strong>
                <p>{site.eventDate}</p>
              </div>
              <div>
                <strong>Vigência</strong>
                <p>
                  {site.termStartsOn
                    ? `${site.termStartsOn} a ${site.termEndsOn}`
                    : "Aguardando aprovação"}
                </p>
              </div>
              <div>
                <strong>Publicação</strong>
                <p>{labels[site.publicationState]}</p>
              </div>
            </CardContent>
          </Card>
          <SmsUsageSection
            siteId={site.id}
            lifecycle={site.lifecycle}
            owner={false}
          />
        </section>
      )}
      {area === "guests" && (
        <GuestGroupsSection
          siteId={site.id}
          lifecycle={site.lifecycle}
          owner={owner}
          isDemo={site.isDemo}
        />
      )}
      {area === "rsvp" && (
        <RsvpSection siteId={site.id} lifecycle={site.lifecycle} />
      )}
      {area === "messages" && (
        <MessagesSection siteId={site.id} lifecycle={site.lifecycle} />
      )}
      {area === "settings" &&
        (owner ? (
          <section
            className="workspace-area settings-area"
            data-area="settings"
          >
            <Card className="panel-section">
              <CardHeader>
                <CardTitle>Ciclo de vida</CardTitle>
                <CardDescription>
                  A aprovação inicia um ano de vigência. O vencimento não
                  inativa o casamento automaticamente.
                </CardDescription>
              </CardHeader>
              <CardContent className="inline-actions">
                {site.lifecycle === "DRAFT" && (
                  <Button
                    disabled={pending}
                    type="button"
                    onClick={() => setLifecycleAction("review/start")}
                  >
                    Enviar para revisão
                  </Button>
                )}
                {site.lifecycle === "IN_REVIEW" && (
                  <Button
                    disabled={pending}
                    type="button"
                    onClick={() => setLifecycleAction("review/approve")}
                  >
                    Aprovar e iniciar vigência
                  </Button>
                )}
                {site.lifecycle === "INACTIVE" ? (
                  <Button
                    disabled={pending}
                    type="button"
                    onClick={() => setLifecycleAction("reactivate")}
                  >
                    Reativar casamento
                  </Button>
                ) : (
                  <Button
                    disabled={pending}
                    type="button"
                    variant="destructive"
                    onClick={() => setLifecycleAction("deactivate")}
                  >
                    Inativar casamento
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="panel-section">
              <CardHeader>
                <CardTitle>Cadastro, datas e publicação</CardTitle>
                <CardDescription>
                  Edite cada informação em uma janela dedicada.
                </CardDescription>
              </CardHeader>
              <CardContent className="inline-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSettingsDialog("profile")}
                >
                  Editar cadastro
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSettingsDialog("dates")}
                >
                  Editar datas
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPublicationState(site.publicationState);
                    setSettingsDialog("publication");
                  }}
                >
                  Registrar publicação
                </Button>
              </CardContent>
            </Card>

            <Card className="panel-section">
              <CardHeader className="flex w-full flex-row items-start justify-between">
                <div>
                  <CardTitle>Administradores</CardTitle>
                  <CardDescription>
                    Gerencie acessos e sessões do casamento.
                  </CardDescription>
                </div>
                <CardAction>
                  <Button
                    type="button"
                    onClick={() => setSettingsDialog("admin")}
                  >
                    Adicionar administrador
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Table className="record-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {admins.map((admin) => (
                      <TableRow className="record-row" key={admin.userId}>
                        <TableCell>{admin.name}</TableCell>
                        <TableCell>{admin.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{labels[admin.state]}</Badge>
                        </TableCell>
                        <TableCell>
                          <OverflowMenu
                            label={`Ações de ${admin.name}`}
                            disabled={pending}
                            items={siteAdminMenuActions(admin.state)}
                            onSelect={(action) =>
                              handleAdminMenuAction(action, admin)
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="panel-section">
              <CardHeader className="flex w-full flex-row items-start justify-between">
                <div>
                  <CardTitle>Domínios</CardTitle>
                  <CardDescription>
                    DNS, hospedagem e renovação continuam sendo operações
                    manuais.
                  </CardDescription>
                </div>
                <CardAction>
                  <Button
                    type="button"
                    onClick={() => setSettingsDialog("domain")}
                  >
                    Registrar domínio
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Table className="record-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domínio</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Renovação</TableHead>
                      <TableHead>Principal</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {domains.map((domain) => (
                      <TableRow
                        className="record-row"
                        key={`${domain.id}-${domain.updatedAt}`}
                      >
                        <TableCell>{domain.hostname}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {labels[domain.state]}
                          </Badge>
                        </TableCell>
                        <TableCell>{domain.expiresOn ?? "—"}</TableCell>
                        <TableCell>
                          {domain.isPrimary ? "Sim" : "Não"}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            type="button"
                            onClick={() => openDomainEdit(domain)}
                          >
                            Editar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <SmsUsageSection
              siteId={site.id}
              lifecycle={site.lifecycle}
              owner
            />

            <Dialog
              open={settingsDialog === "profile"}
              onOpenChange={(open) => !open && closeSettingsDialog()}
            >
              <DialogContent className="max-w-2xl">
                <DialogTitle>Editar cadastro</DialogTitle>
                <DialogDescription>
                  Atualize identificação pública e origens autorizadas.
                </DialogDescription>
                {error && <p role="alert">{error}</p>}
                <form
                  className="data-form form-grid"
                  onSubmit={async (event) => {
                    const saved = await submit(
                      event,
                      base,
                      (form) => ({
                        displayName: form.get("name"),
                        coupleNames: [form.get("first"), form.get("second")],
                        publicUrl: form.get("url") || null,
                        trustedOrigins: String(form.get("origins"))
                          .split(/\s+/)
                          .filter(Boolean),
                      }),
                      "PATCH",
                    );
                    if (saved) closeSettingsDialog();
                  }}
                >
                  <label htmlFor="site-display-name">
                    Nome do casamento
                    <Input
                      id="site-display-name"
                      name="name"
                      required
                      maxLength={160}
                      defaultValue={site.displayName}
                    />
                  </label>
                  <label htmlFor="site-couple-first">
                    Nome do noivo
                    <Input
                      id="site-couple-first"
                      name="first"
                      required
                      maxLength={120}
                      defaultValue={site.coupleNames[0]}
                    />
                  </label>
                  <label htmlFor="site-couple-second">
                    Nome da noiva
                    <Input
                      id="site-couple-second"
                      name="second"
                      required
                      maxLength={120}
                      defaultValue={site.coupleNames[1]}
                    />
                  </label>
                  <label htmlFor="site-public-url">
                    Endereço público
                    <Input
                      id="site-public-url"
                      name="url"
                      type="url"
                      defaultValue={site.publicUrl ?? ""}
                    />
                  </label>
                  <label htmlFor="site-trusted-origins">
                    Origens autorizadas (uma por linha)
                    <Textarea
                      id="site-trusted-origins"
                      name="origins"
                      rows={3}
                      defaultValue={site.trustedOrigins?.join("\n") ?? ""}
                      placeholder="https://casamento.exemplo.com"
                    />
                  </label>
                  <div className="inline-actions">
                    <Button disabled={pending} type="submit">
                      Salvar cadastro
                    </Button>
                    <DialogClose
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                        />
                      }
                    >
                      Cancelar
                    </DialogClose>
                  </div>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog
              open={settingsDialog === "dates"}
              onOpenChange={(open) => !open && closeSettingsDialog()}
            >
              <DialogContent>
                <DialogTitle>Editar datas</DialogTitle>
                <DialogDescription>
                  Altere a data do casamento e, quando disponível, a vigência.
                </DialogDescription>
                {error && <p role="alert">{error}</p>}
                <form className="data-form form-grid" onSubmit={submitDates}>
                  <label htmlFor="site-event-date">
                    Data do casamento
                    <DatePicker
                      id="site-event-date"
                      name="date"
                      defaultValue={site.eventDate}
                    />
                  </label>
                  {site.termStartsOn && (
                    <>
                      <label htmlFor="site-term-start">
                        Início da vigência
                        <DatePicker
                          id="site-term-start"
                          name="start"
                          defaultValue={site.termStartsOn}
                        />
                      </label>
                      <label htmlFor="site-term-end">
                        Fim da vigência
                        <DatePicker
                          id="site-term-end"
                          name="end"
                          defaultValue={site.termEndsOn ?? ""}
                        />
                      </label>
                    </>
                  )}
                  <div className="inline-actions">
                    <Button disabled={pending} type="submit">
                      Salvar datas
                    </Button>
                    <DialogClose
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                        />
                      }
                    >
                      Cancelar
                    </DialogClose>
                  </div>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog
              open={settingsDialog === "publication"}
              onOpenChange={(open) => !open && closeSettingsDialog()}
            >
              <DialogContent>
                <DialogTitle>Registrar publicação</DialogTitle>
                <DialogDescription>
                  Registre após verificar a publicação. Esta ação não altera a
                  hospedagem.
                </DialogDescription>
                {error && <p role="alert">{error}</p>}
                <form
                  className="data-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const saved = await mutate(
                      `${base}/publication`,
                      { publicationState },
                      "PATCH",
                    );
                    if (saved) closeSettingsDialog();
                  }}
                >
                  <label htmlFor="site-publication-state">
                    Publicação registrada
                    <Select
                      value={publicationState}
                      onValueChange={(value) =>
                        setPublicationState(
                          value as SiteView["publicationState"],
                        )
                      }
                    >
                      <SelectTrigger id="site-publication-state">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="UNPUBLISHED">
                          Não publicado
                        </SelectItem>
                        <SelectItem value="PUBLISHED">Publicado</SelectItem>
                        <SelectItem value="PLACEHOLDER">
                          Página neutra
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="inline-actions">
                    <Button disabled={pending} type="submit">
                      Registrar publicação
                    </Button>
                    <DialogClose
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                        />
                      }
                    >
                      Cancelar
                    </DialogClose>
                  </div>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog
              open={settingsDialog === "admin"}
              onOpenChange={(open) => !open && closeSettingsDialog()}
            >
              <DialogContent>
                <DialogTitle>Adicionar administrador</DialogTitle>
                <DialogDescription>
                  O link de ativação será exibido apenas nesta sessão.
                </DialogDescription>
                {error && <p role="alert">{error}</p>}
                <form
                  className="data-form"
                  onSubmit={async (event) => {
                    const saved = await submit(
                      event,
                      `${base}/admins`,
                      (form) => ({
                        name: form.get("name"),
                        email: form.get("email"),
                      }),
                    );
                    if (saved) closeSettingsDialog();
                  }}
                >
                  <label htmlFor="new-admin-name">
                    Nome do administrador
                    <Input
                      id="new-admin-name"
                      name="name"
                      required
                      maxLength={160}
                    />
                  </label>
                  <label htmlFor="new-admin-email">
                    E-mail
                    <Input
                      id="new-admin-email"
                      name="email"
                      type="email"
                      required
                      maxLength={320}
                    />
                  </label>
                  <div className="inline-actions">
                    <Button disabled={pending} type="submit">
                      Adicionar administrador
                    </Button>
                    <DialogClose
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                        />
                      }
                    >
                      Cancelar
                    </DialogClose>
                  </div>
                </form>
              </DialogContent>
            </Dialog>

            <Dialog
              open={
                settingsDialog === "domain" || settingsDialog === "domain-edit"
              }
              onOpenChange={(open) => !open && closeSettingsDialog()}
            >
              <DialogContent>
                <DialogTitle>
                  {domainToEdit ? "Editar domínio" : "Registrar domínio"}
                </DialogTitle>
                <DialogDescription>
                  O registro não executa DNS, hospedagem ou renovação.
                </DialogDescription>
                {error && <p role="alert">{error}</p>}
                {domainToEdit ? (
                  <form className="data-form" onSubmit={saveDomainEdit}>
                    <p>
                      <strong>{domainToEdit.hostname}</strong>
                    </p>
                    <label htmlFor="domain-state">
                      Estado
                      <Select
                        value={domainState}
                        onValueChange={(value) =>
                          setDomainState(value as Domain["state"])
                        }
                      >
                        <SelectTrigger id="domain-state">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["NONE", "PENDING", "ACTIVE", "INACTIVE"].map(
                            (value) => (
                              <SelectItem key={value} value={value}>
                                {labels[value]}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </label>
                    <label htmlFor="domain-expiry">
                      Renovação
                      <div className="inline-actions">
                        <DatePicker
                          id="domain-expiry"
                          value={domainExpiry || undefined}
                          onValueChange={(value) =>
                            setDomainExpiry(value ?? "")
                          }
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending || !domainExpiry}
                          onClick={() => setDomainExpiry("")}
                        >
                          Limpar data
                        </Button>
                      </div>
                    </label>
                    <label
                      className="checkbox-label"
                      htmlFor="domain-primary-edit"
                    >
                      <Checkbox
                        id="domain-primary-edit"
                        checked={domainPrimary}
                        onCheckedChange={(checked) =>
                          setDomainPrimary(checked === true)
                        }
                      />
                      Domínio principal
                    </label>
                    <div className="inline-actions">
                      <Button disabled={pending} type="submit">
                        Salvar domínio
                      </Button>
                      <DialogClose
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                          />
                        }
                      >
                        Cancelar
                      </DialogClose>
                    </div>
                  </form>
                ) : (
                  <form
                    className="data-form"
                    onSubmit={async (event) => {
                      const saved = await submit(
                        event,
                        `${base}/domains`,
                        (form) => ({
                          hostname: String(form.get("hostname"))
                            .trim()
                            .toLowerCase(),
                          isPrimary: form.get("primary") === "on",
                          expiresOn: form.get("expiry") || null,
                        }),
                      );
                      if (saved) closeSettingsDialog();
                    }}
                  >
                    <label htmlFor="new-domain-hostname">
                      Domínio
                      <Input
                        id="new-domain-hostname"
                        name="hostname"
                        placeholder="casamento.exemplo.com"
                        required
                        maxLength={253}
                      />
                    </label>
                    <label htmlFor="new-domain-expiry">
                      Renovação
                      <DatePicker id="new-domain-expiry" name="expiry" />
                    </label>
                    <label
                      className="checkbox-label"
                      htmlFor="new-domain-primary"
                    >
                      <Checkbox id="new-domain-primary" name="primary" />
                      Domínio principal
                    </label>
                    <div className="inline-actions">
                      <Button disabled={pending} type="submit">
                        Registrar domínio
                      </Button>
                      <DialogClose
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                          />
                        }
                      >
                        Cancelar
                      </DialogClose>
                    </div>
                  </form>
                )}
              </DialogContent>
            </Dialog>

            <AlertDialog
              open={lifecycleAction !== null}
              onOpenChange={(open) => !open && setLifecycleAction(null)}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{lifecycleLabel}</AlertDialogTitle>
                  <AlertDialogDescription>
                    O servidor continua sendo a autoridade para esta transição.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>
                    Cancelar
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={pending}
                    onClick={() => {
                      if (lifecycleAction)
                        void mutate(`${base}/${lifecycleAction}`, {});
                      setLifecycleAction(null);
                    }}
                  >
                    Confirmar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
              open={adminToDisable !== null}
              onOpenChange={(open) => !open && setAdminToDisable(null)}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Desativar acesso?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {adminToDisable
                      ? `Desativar o acesso de ${adminToDisable.name} e encerrar todas as sessões?`
                      : ""}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>
                    Cancelar
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={pending}
                    onClick={() => {
                      if (adminToDisable) {
                        setAccessLink("");
                        void mutate(
                          `/v1/owner/admins/${adminToDisable.userId}/disable`,
                          { userId: adminToDisable.userId },
                        );
                      }
                      setAdminToDisable(null);
                    }}
                  >
                    Desativar acesso
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>
        ) : (
          <Card className="panel-section" data-area="settings">
            <CardHeader>
              <CardTitle>Configurações indisponíveis</CardTitle>
              <CardDescription>
                Somente o proprietário pode acessar as configurações deste
                casamento.
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
    </>
  );
}

export function lifecycleLabel(value: string) {
  return labels[value] ?? value;
}
