import type { MeResponse, SiteRecord } from "@entrelacos/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { AdminShell, ShellLoading } from "./AdminShell";
import { resolveSiteArea, type SiteArea } from "./adminNavigation";
import { formatBrazilianDate } from "./brazilianDate";
import {
  createPanelAuthenticationActions,
  mountPanelSessionLifecycle,
  type PanelSessionSnapshot,
  panelActorOwner,
} from "./panelActor";
import {
  getPanelLanding,
  getSelectedSiteAccess,
  loadAssignedSiteName,
} from "./panelMemberships";
import { SiteWorkspace } from "./SiteWorkspace";

export function Panel({ siteId, area }: { siteId?: string; area?: SiteArea }) {
  const snapshot = useSyncExternalStore(
    panelActorOwner.subscribe,
    panelActorOwner.getSnapshot,
    panelActorOwner.getServerSnapshot,
  );
  const suspended = useSyncExternalStore(
    panelActorOwner.subscribeSuspension,
    panelActorOwner.isSuspended,
    panelActorOwner.getServerSuspensionSnapshot,
  );
  const [siteName, setSiteName] = useState<string>();
  const authActions = useRef<ReturnType<
    typeof createPanelAuthenticationActions
  > | null>(null);
  useEffect(() => {
    const actions = createPanelAuthenticationActions();
    authActions.current = actions;
    const cleanup = mountPanelSessionLifecycle({ target: window, document });
    return () => {
      actions.dispose();
      if (authActions.current === actions) authActions.current = null;
      cleanup();
    };
  }, []);
  useEffect(() => {
    setSiteName(undefined);
    if (
      snapshot.status === "unauthenticated" &&
      panelActorOwner.getSnapshot() === snapshot
    ) {
      const next = window.location.pathname + window.location.search;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [snapshot]);

  async function logout() {
    const actions = authActions.current;
    if (!actions) return;
    await submitPanelSignOut(
      actions,
      () => window.location.replace("/login"),
      () => toast.error("Não foi possível sair. Tente novamente."),
    );
  }

  return (
    <fieldset
      className="contents"
      disabled={suspended}
      inert={suspended}
      onSubmitCapture={(event) => {
        if (panelActorOwner.isSuspended()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (panelActorOwner.isSuspended()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <PanelSessionView
        snapshot={snapshot}
        siteId={siteId}
        area={area}
        siteName={siteName}
        onSiteName={setSiteName}
        onVerify={() => {
          void panelActorOwner.load(true).catch(() => {});
        }}
        onLogout={() => void logout()}
      />
    </fieldset>
  );
}

export function signOutPanel() {
  return panelActorOwner.runAuthentication(() =>
    apiRequest("/v1/auth/sign-out", { method: "POST", body: {} }),
  );
}
export function submitPanelSignOut(
  actions: ReturnType<typeof createPanelAuthenticationActions>,
  onSuccess: () => void,
  onFailure: () => void,
) {
  return actions.run(signOutPanel, onSuccess, onFailure);
}

export function PanelSessionView({
  snapshot,
  siteId,
  area,
  siteName,
  onSiteName,
  onVerify,
  onLogout,
}: {
  snapshot: PanelSessionSnapshot;
  siteId?: string;
  area?: SiteArea;
  siteName?: string;
  onSiteName?: (name: string) => void;
  onVerify: () => void;
  onLogout: () => void;
}) {
  const { actor, sessionEpoch } = snapshot;
  if (snapshot.status !== "verified" || !actor || sessionEpoch === null) {
    return (
      <ShellLoading>
        <p
          className={adminStyles.alert}
          role={snapshot.status === "loading" ? "status" : "alert"}
        >
          {snapshot.status === "loading"
            ? "Verificando sessão…"
            : snapshot.status === "denied"
              ? "Acesso ao painel indisponível. Verifique sua sessão."
              : "Verifique sua sessão para abrir o painel."}
        </p>
        {snapshot.status !== "loading" && (
          <Button onClick={onVerify}>Verificar sessão</Button>
        )}
      </ShellLoading>
    );
  }

  const landing = getPanelLanding(actor);
  if (!siteId && landing.kind === "SITE")
    return <SiteAdminRedirect siteId={landing.siteId} />;
  if (!siteId && landing.kind === "EMPTY") {
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          Nenhum casamento foi associado a esta conta.
        </p>
      </ShellLoading>
    );
  }

  const selectedAccess = siteId ? getSelectedSiteAccess(actor, siteId) : null;
  if (siteId && actor.user.role !== "OWNER" && !selectedAccess)
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          Acesso negado ou casamento não encontrado.
        </p>
      </ShellLoading>
    );
  const selectedRole = selectedAccess?.membershipRole ?? actor.user.role;
  const resolvedArea = resolveSiteArea(selectedRole, area);
  if (siteId && area && resolvedArea !== area) {
    return <SiteAreaRedirect siteId={siteId} area={resolvedArea} />;
  }

  return (
    <AdminShell
      actor={actor}
      siteAccess={selectedAccess ?? undefined}
      siteId={siteId}
      siteName={siteName}
      area={siteId ? resolvedArea : undefined}
      onLogout={onLogout}
    >
      {siteId ? (
        <SiteWorkspace
          key={`${siteId}:${sessionEpoch}`}
          siteId={siteId}
          sessionEpoch={sessionEpoch}
          owner={actor.user.role === "OWNER"}
          access={selectedAccess}
          area={resolvedArea}
          onSiteName={onSiteName}
        />
      ) : landing.kind === "SELECT" ? (
        <AssignedSites key={sessionEpoch} actor={actor} />
      ) : (
        <OwnerSites key={sessionEpoch} />
      )}
    </AdminShell>
  );
}

function AssignedSiteName({ siteId }: { siteId: string }) {
  const [result, setResult] = useState<{ siteId: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void loadAssignedSiteName(siteId)
      .then((name) => {
        if (active) setResult({ siteId, name });
      })
      .catch(() => {
        if (active) setResult({ siteId, name: "Casamento indisponível" });
      });
    return () => {
      active = false;
    };
  }, [siteId]);
  return (
    <span>
      {result?.siteId === siteId ? result.name : "Carregando casamento…"}
    </span>
  );
}

function AssignedSites({ actor }: { actor: MeResponse }) {
  return (
    <section className="grid gap-5">
      <h1 className={displayHeading}>Seus casamentos</h1>
      <p className="m-0 text-admin-muted">
        Escolha o casamento que deseja acompanhar.
      </p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {(actor.memberships ?? [])
          .filter((entry) => entry.userId === actor.user.id)
          .map((entry) => (
            <li key={entry.siteId}>
              <Link
                className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-admin-line bg-admin-surface p-4 text-admin-graphite no-underline"
                to="/sites/$siteId/invitations"
                params={{ siteId: entry.siteId }}
              >
                <AssignedSiteName siteId={entry.siteId} />
                <span className="text-sm text-admin-muted">
                  {entry.membershipRole === "SITE_ASSISTANT"
                    ? "Assessor"
                    : "Administrador"}
                </span>
              </Link>
            </li>
          ))}
      </ul>
    </section>
  );
}

function SiteAdminRedirect({ siteId }: { siteId: string }) {
  useEffect(() => {
    window.location.replace(`/sites/${encodeURIComponent(siteId)}/invitations`);
  }, [siteId]);
  return <ShellLoading>Abrindo seu casamento…</ShellLoading>;
}

function SiteAreaRedirect({
  siteId,
  area,
}: {
  siteId: string;
  area: SiteArea;
}) {
  useEffect(() => {
    window.location.replace(`/sites/${encodeURIComponent(siteId)}/${area}`);
  }, [area, siteId]);
  return <ShellLoading>Redirecionando…</ShellLoading>;
}

function OwnerSites() {
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async (next?: string) => {
    const result = await apiRequest<{
      sites: SiteRecord[];
      nextCursor: string | null;
    }>(`/v1/owner/sites${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
    setSites((previous) =>
      next ? [...previous, ...result.sites] : result.sites,
    );
    setCursor(result.nextCursor);
  }, []);

  async function loadMore() {
    if (!cursor || pending || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar mais casamentos.",
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    load().catch((cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar os casamentos.",
      ),
    );
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      const result = await apiRequest<{ site: SiteRecord }>("/v1/owner/sites", {
        method: "POST",
        body: {
          repositorySlug: form.get("slug"),
          provisioningKey: form.get("key"),
          displayName: form.get("name"),
          coupleNames: [form.get("first"), form.get("second")],
          eventDate: form.get("date"),
        },
      });
      setDialogOpen(false);
      window.location.assign(
        `/sites/${encodeURIComponent(result.site.id)}/invitations`,
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Não foi possível criar o casamento.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <section className="mb-6 flex items-end justify-between gap-8 [@media(max-width:760px)]:flex-col [@media(max-width:760px)]:items-start [@media(max-width:760px)]:gap-5">
        <div>
          <p className="m-0 mb-3.5 text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
            Gestão global
          </p>
          <h1
            className={`m-0 max-w-none text-[clamp(1.85rem,3vw,2.6rem)] ${displayHeading}`}
          >
            Seus casamentos
          </h1>
          <p className="mt-[18px] max-w-[56ch] leading-[1.6] text-admin-muted">
            Acompanhe cada celebração e mantenha tudo pronto para o grande dia.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <Button
            className="shrink-0 [@media(max-width:760px)]:w-full"
            type="button"
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            Novo casamento
          </Button>
          <DialogContent className="w-[min(680px,calc(100vw-32px))] max-w-[min(680px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-x-hidden overflow-y-auto rounded-2xl border border-admin-line bg-admin-surface p-[30px] shadow-admin [@media(max-width:760px)]:p-6 [@media(max-width:760px)]:px-[18px]">
            <DialogTitle className="mb-2.5 font-admin-display text-[2.3rem] font-normal">
              Novo casamento
            </DialogTitle>
            <DialogDescription className="m-0 leading-[1.6] text-admin-muted">
              Cadastre os dados iniciais. A mesma referência mantém novas
              tentativas idempotentes e preserva os dados já salvos.
            </DialogDescription>
            <form
              className="my-7 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-[18px]"
              onSubmit={create}
            >
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-name"
              >
                Nome do casamento
                <Input id="site-name" name="name" required maxLength={160} />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-slug"
              >
                Identificador do site
                <Input
                  id="site-slug"
                  name="slug"
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  maxLength={64}
                  placeholder="ana-e-joao"
                />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-key"
              >
                Referência do cadastro
                <Input
                  id="site-key"
                  name="key"
                  required
                  maxLength={160}
                  placeholder="casamento-ana-joao-2027"
                />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-date"
              >
                Data do casamento
                <DatePicker id="site-date" name="date" required />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-first-name"
              >
                Nome do noivo
                <Input
                  id="site-first-name"
                  name="first"
                  required
                  maxLength={120}
                />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-second-name"
              >
                Nome da noiva
                <Input
                  id="site-second-name"
                  name="second"
                  required
                  maxLength={120}
                />
              </label>
              <div className="col-span-full mt-2 flex justify-end gap-2.5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-2 [&>*]:[@media(max-width:760px)]:w-full">
                <DialogClose
                  render={
                    <Button type="button" variant="ghost">
                      Cancelar
                    </Button>
                  }
                />
                <Button type="submit" disabled={pending}>
                  {pending ? "Salvando…" : "Criar casamento"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </section>

      {error && (
        <p
          className="break-words rounded-[9px] border border-[rgb(142_58_42_/_30%)] bg-admin-terracotta-wash px-3.5 py-3 text-admin-terracotta-deep"
          role="alert"
        >
          {error}
        </p>
      )}

      <Card className={`${adminStyles.surface} overflow-hidden`}>
        <CardHeader>
          <CardTitle>Casamentos cadastrados</CardTitle>
          <CardDescription>
            Selecione um casamento para acompanhar status e acessos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto [@media(max-width:760px)]:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Casamento</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead aria-label="Ação" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell>
                      <Link
                        className="grid gap-1 no-underline"
                        to="/sites/$siteId/invitations"
                        params={{ siteId: site.id }}
                      >
                        <strong>{site.displayName}</strong>
                        <span className="text-[0.88rem] text-admin-muted">
                          {site.coupleNames.join(" & ")}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>{formatBrazilianDate(site.eventDate)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          site.lifecycle === "ACTIVE" ? "default" : "secondary"
                        }
                      >
                        {lifecycleLabel(site.lifecycle)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        className="text-[0.88rem] font-bold text-admin-terracotta-deep no-underline"
                        to="/sites/$siteId/invitations"
                        params={{ siteId: site.id }}
                      >
                        Abrir
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="hidden gap-2.5 [@media(max-width:760px)]:grid">
            {sites.map((site) => (
              <Link
                className="grid gap-[7px] rounded-xl border border-admin-line bg-admin-surface p-[18px] no-underline"
                to="/sites/$siteId/invitations"
                params={{ siteId: site.id }}
                key={site.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-block text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
                    Casamento
                  </span>
                  <Badge
                    variant={
                      site.lifecycle === "ACTIVE" ? "default" : "secondary"
                    }
                  >
                    {lifecycleLabel(site.lifecycle)}
                  </Badge>
                </div>
                <strong>{site.displayName}</strong>
                <span className="text-[0.88rem] text-admin-muted">
                  {site.coupleNames.join(" & ")}
                </span>
                <small className="mt-1 text-admin-muted">
                  {formatBrazilianDate(site.eventDate)}
                </small>
              </Link>
            ))}
          </div>
          {sites.length === 0 && (
            <p className="mt-6 leading-[1.6] text-admin-muted">
              Nenhum casamento cadastrado.
            </p>
          )}
        </CardContent>
      </Card>

      {cursor && (
        <Button
          className="mt-[18px]"
          type="button"
          variant="outline"
          disabled={pending || loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Carregando…" : "Carregar mais"}
        </Button>
      )}
    </div>
  );
}

export function lifecycleLabel(value: string) {
  return (
    (
      {
        DRAFT: "Rascunho",
        IN_REVIEW: "Em revisão",
        ACTIVE: "Ativo",
        INACTIVE: "Inativo",
      } as Record<string, string>
    )[value] ?? value
  );
}
