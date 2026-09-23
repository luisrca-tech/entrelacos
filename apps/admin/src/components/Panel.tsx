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
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { ApiError, apiRequest } from "../lib/apiClient";
import { AdminShell, ShellLoading } from "./AdminShell";
import { resolveSiteArea, type SiteArea } from "./adminNavigation";
import { formatBrazilianDate } from "./brazilianDate";
import {
  getCachedPanelActor,
  loadPanelActor,
  resetPanelActorCache,
} from "./panelActor";
import { SiteWorkspace } from "./SiteWorkspace";

export function Panel({ siteId, area }: { siteId?: string; area?: SiteArea }) {
  const [actor, setActor] = useState<MeResponse | null>(getCachedPanelActor);
  const [siteName, setSiteName] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadPanelActor()
      .then((value) => {
        if (active) setActor(value);
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) {
          const next = window.location.pathname + window.location.search;
          window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        } else {
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível abrir o painel.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    try {
      await apiRequest("/v1/auth/sign-out", { method: "POST", body: {} });
      resetPanelActorCache();
      window.location.replace("/login");
    } catch {
      setError("Não foi possível sair. Tente novamente.");
    }
  }

  if (error) {
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          {error}
        </p>
      </ShellLoading>
    );
  }
  if (!actor) return <ShellLoading>Carregando painel…</ShellLoading>;

  if (!siteId && actor.user.role === "SITE_ADMIN") {
    if (actor.siteId) return <SiteAdminRedirect siteId={actor.siteId} />;
    return (
      <ShellLoading>
        <p className={adminStyles.alert} role="alert">
          Nenhum casamento foi associado a esta conta.
        </p>
      </ShellLoading>
    );
  }

  const resolvedArea = resolveSiteArea(actor.user.role, area);
  if (siteId && area && resolvedArea !== area) {
    return <SiteAreaRedirect siteId={siteId} area={resolvedArea} />;
  }

  return (
    <AdminShell
      actor={actor}
      siteId={siteId}
      siteName={siteName}
      area={siteId ? resolvedArea : undefined}
      onLogout={() => void logout()}
    >
      {siteId ? (
        <SiteWorkspace
          siteId={siteId}
          owner={actor.user.role === "OWNER"}
          area={resolvedArea}
          onSiteName={setSiteName}
        />
      ) : (
        <OwnerSites />
      )}
    </AdminShell>
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
  const [createError, setCreateError] = useState("");

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
      setError(
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
    setError("");
    setCreateError("");
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
      setCreateError(
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
              setCreateError("");
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
            {createError && (
              <p
                className="break-words rounded-[9px] border border-[rgb(142_58_42_/_30%)] bg-admin-terracotta-wash px-3.5 py-3 text-admin-terracotta-deep"
                role="alert"
              >
                {createError}
              </p>
            )}
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
