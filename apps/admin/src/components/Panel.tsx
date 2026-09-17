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
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import { AdminShell, ShellLoading } from "./AdminShell";
import { resolveSiteArea, type SiteArea } from "./adminNavigation";
import { SiteWorkspace } from "./SiteWorkspace";

export function Panel({ siteId, area }: { siteId?: string; area?: SiteArea }) {
  const [actor, setActor] = useState<MeResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<MeResponse>("/v1/me")
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
      window.location.replace("/login");
    } catch {
      setError("Não foi possível sair. Tente novamente.");
    }
  }

  if (error) {
    return (
      <ShellLoading>
        <p role="alert">{error}</p>
      </ShellLoading>
    );
  }
  if (!actor) return <ShellLoading>Carregando painel…</ShellLoading>;

  if (!siteId && actor.user.role === "SITE_ADMIN") {
    if (actor.siteId) return <SiteAdminRedirect siteId={actor.siteId} />;
    return (
      <ShellLoading>
        <p role="alert">Nenhum casamento foi associado a esta conta.</p>
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
      area={siteId ? resolvedArea : undefined}
      onLogout={() => void logout()}
    >
      {siteId ? (
        <SiteWorkspace
          siteId={siteId}
          owner={actor.user.role === "OWNER"}
          area={resolvedArea}
        />
      ) : (
        <OwnerSites />
      )}
    </AdminShell>
  );
}

function SiteAdminRedirect({ siteId }: { siteId: string }) {
  useEffect(() => {
    window.location.replace(`/sites/${encodeURIComponent(siteId)}/overview`);
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
        `/sites/${encodeURIComponent(result.site.id)}/overview`,
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
    <div className="owner-dashboard">
      <section className="panel-heading owner-heading">
        <div>
          <p className="eyebrow">Gestão global</p>
          <h1>Seus casamentos</h1>
          <p className="lede">
            Acompanhe cada celebração e mantenha tudo pronto para o grande dia.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <Button
            type="button"
            onClick={() => {
              setCreateError("");
              setDialogOpen(true);
            }}
          >
            Novo casamento
          </Button>
          <DialogContent className="create-site-dialog">
            <DialogTitle>Novo casamento</DialogTitle>
            <DialogDescription>
              Cadastre os dados iniciais. A mesma referência mantém novas
              tentativas idempotentes e preserva os dados já salvos.
            </DialogDescription>
            {createError && <p role="alert">{createError}</p>}
            <form className="data-form form-grid" onSubmit={create}>
              <label htmlFor="site-name">
                Nome do casamento
                <Input id="site-name" name="name" required maxLength={160} />
              </label>
              <label htmlFor="site-slug">
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
              <label htmlFor="site-key">
                Referência do cadastro
                <Input
                  id="site-key"
                  name="key"
                  required
                  maxLength={160}
                  placeholder="casamento-ana-joao-2027"
                />
              </label>
              <label htmlFor="site-date">
                Data do casamento
                <DatePicker id="site-date" name="date" required />
              </label>
              <label htmlFor="site-first-name">
                Primeiro nome do casal
                <Input
                  id="site-first-name"
                  name="first"
                  required
                  maxLength={120}
                />
              </label>
              <label htmlFor="site-second-name">
                Segundo nome do casal
                <Input
                  id="site-second-name"
                  name="second"
                  required
                  maxLength={120}
                />
              </label>
              <div className="dialog-actions">
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

      {error && <p role="alert">{error}</p>}

      <Card className="sites-table-card">
        <CardHeader>
          <CardTitle>Casamentos cadastrados</CardTitle>
          <CardDescription>
            Selecione um casamento para acompanhar status e acessos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="desktop-table-wrap">
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
                      <a
                        className="site-table-link"
                        href={`/sites/${site.id}/overview`}
                      >
                        <strong>{site.displayName}</strong>
                        <span>{site.coupleNames.join(" & ")}</span>
                      </a>
                    </TableCell>
                    <TableCell>{formatDate(site.eventDate)}</TableCell>
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
                      <a
                        className="table-action"
                        href={`/sites/${site.id}/overview`}
                      >
                        Abrir
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mobile-site-cards">
            {sites.map((site) => (
              <a
                className="site-mobile-card"
                href={`/sites/${site.id}/overview`}
                key={site.id}
              >
                <div className="site-mobile-card-top">
                  <span className="card-label">Casamento</span>
                  <Badge
                    variant={
                      site.lifecycle === "ACTIVE" ? "default" : "secondary"
                    }
                  >
                    {lifecycleLabel(site.lifecycle)}
                  </Badge>
                </div>
                <strong>{site.displayName}</strong>
                <span>{site.coupleNames.join(" & ")}</span>
                <small>{formatDate(site.eventDate)}</small>
              </a>
            ))}
          </div>
          {sites.length === 0 && (
            <p className="empty-state">Nenhum casamento cadastrado.</p>
          )}
        </CardContent>
      </Card>

      {cursor && (
        <Button
          className="load-more"
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

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
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
