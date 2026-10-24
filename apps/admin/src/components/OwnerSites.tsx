import type { SiteRecord } from "@entrelacos/contracts";
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
import { formatBrazilianDate } from "./brazilianDate";
import { type PanelSessionSnapshot, panelActorOwner } from "./panelActor";

const navigateToSite = (path: string) => window.location.assign(path);

export function OwnerSites({
  navigate = navigateToSite,
}: {
  navigate?: (path: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    panelActorOwner.subscribe,
    panelActorOwner.getSnapshot,
    panelActorOwner.getServerSnapshot,
  );
  if (
    snapshot.status !== "verified" ||
    snapshot.actor?.user.role !== "OWNER" ||
    snapshot.sessionEpoch === null
  ) {
    return (
      <p role="status" className="text-admin-muted">
        Verificando acesso aos casamentos…
      </p>
    );
  }
  return (
    <OwnerSitesRuntime
      key={snapshot.sessionEpoch}
      snapshot={snapshot}
      navigate={navigate}
    />
  );
}

function OwnerSitesRuntime({
  snapshot,
  navigate,
}: {
  snapshot: PanelSessionSnapshot;
  navigate: (path: string) => void;
}) {
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retryCursor, setRetryCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState("ALL");
  const alive = useRef(true);
  const busy = useRef(false);
  const creating = useRef(false);
  const requestVersion = useRef(0);
  const current = useCallback(
    (attempt?: number) =>
      alive.current &&
      panelActorOwner.getSnapshot() === snapshot &&
      snapshot.status === "verified" &&
      snapshot.actor?.user.role === "OWNER" &&
      Date.parse(snapshot.actor.session.expiresAt) > Date.now() &&
      (attempt === undefined || attempt === requestVersion.current),
    [snapshot],
  );

  const load = useCallback(
    async (next?: string) => {
      if (busy.current || creating.current || !current()) return;
      busy.current = true;
      const attempt = ++requestVersion.current;
      setError("");
      if (next) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await apiRequest<{
          sites: SiteRecord[];
          nextCursor: string | null;
        }>(
          `/v1/owner/sites${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (!current(attempt)) return;
        setSites((previous) => {
          if (!next) return result.sites;
          const ids = new Set(previous.map((site) => site.id));
          return [
            ...previous,
            ...result.sites.filter((site) => !ids.has(site.id)),
          ];
        });
        setCursor(result.nextCursor);
      } catch (cause) {
        if (!current(attempt)) return;
        panelActorOwner.reportFailure(cause, snapshot.sessionEpoch);
        if (!current(attempt)) return;
        setRetryCursor(next);
        setError(
          next
            ? "Não foi possível carregar mais casamentos."
            : "Não foi possível carregar os casamentos.",
        );
      } finally {
        if (current(attempt)) {
          busy.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [current, snapshot],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      requestVersion.current += 1;
      busy.current = false;
    };
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || creating.current || busy.current) return;
    const form = new FormData(event.currentTarget);
    creating.current = true;
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
      if (!current()) return;
      setDialogOpen(false);
      navigate(`/sites/${encodeURIComponent(result.site.id)}/home`);
    } catch (cause) {
      if (!current()) return;
      panelActorOwner.reportFailure(cause, snapshot.sessionEpoch);
      if (current())
        toast.error(
          "Não foi possível criar o casamento. Confira os dados e tente novamente com a mesma referência.",
        );
    } finally {
      if (current()) {
        creating.current = false;
        setPending(false);
      }
    }
  }

  const query = normalizeSearch(search.trim());
  const visibleSites = sites.filter(
    (site) =>
      (lifecycle === "ALL" || site.lifecycle === lifecycle) &&
      normalizeSearch(
        `${site.displayName} ${site.coupleNames.join(" ")}`,
      ).includes(query),
  );

  return (
    <div>
      <section className="mb-6 flex items-end justify-between gap-8 [@media(max-width:760px)]:flex-col [@media(max-width:760px)]:items-start [@media(max-width:760px)]:gap-5">
        <div>
          <p className="m-0 mb-3.5 text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-muted">
            Painel EntreLaços
          </p>
          <h1
            className={`m-0 max-w-none text-[clamp(1.85rem,3vw,2.6rem)] ${displayHeading}`}
          >
            Seus casamentos
          </h1>
          <p className="mt-[18px] max-w-[56ch] leading-[1.6] text-admin-muted">
            Escolha um casamento para organizar convites, presentes e
            recebimentos.
          </p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!pending) setDialogOpen(open);
          }}
        >
          <Button
            className="shrink-0 [@media(max-width:760px)]:w-full"
            type="button"
            disabled={loading || loadingMore || pending}
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
              Preencha os dados do casal e as referências para criar o site.
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
                <Input
                  id="site-name"
                  name="name"
                  required
                  maxLength={160}
                  disabled={pending}
                />
              </label>
              <label
                className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="site-date"
              >
                Data do casamento
                <DatePicker
                  id="site-date"
                  name="date"
                  required
                  disabled={pending}
                />
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
                  disabled={pending}
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
                  disabled={pending}
                  maxLength={120}
                />
              </label>
              <fieldset className="col-span-full grid min-w-0 gap-[18px] border-t border-admin-line pt-4 sm:grid-cols-2">
                <legend className="px-1 text-sm font-semibold text-admin-graphite">
                  Referências do site
                </legend>
                <p className="col-span-full m-0 text-sm text-admin-muted">
                  Informe as referências deste cadastro. Em uma nova tentativa,
                  mantenha os mesmos valores.
                </p>
                <label
                  className="grid min-w-0 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="site-slug"
                >
                  Identificador do site
                  <Input
                    id="site-slug"
                    name="slug"
                    required
                    disabled={pending}
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
                    disabled={pending}
                    maxLength={160}
                    placeholder="casamento-ana-joao-2027"
                  />
                </label>
              </fieldset>
              <div className="col-span-full mt-2 flex justify-end gap-2.5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-2 [&>*]:[@media(max-width:760px)]:w-full">
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
                <Button type="submit" disabled={pending}>
                  {pending ? "Salvando…" : "Criar casamento"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </section>

      {error && (
        <div className="mb-5 grid gap-3 rounded-xl border border-admin-line bg-admin-surface p-5">
          <p className="m-0 text-sm text-admin-muted" role="alert">
            {error}
          </p>
          <Button
            className="w-fit"
            type="button"
            variant="outline"
            disabled={loading || loadingMore || pending}
            onClick={() => void load(retryCursor)}
          >
            Tentar novamente
          </Button>
        </div>
      )}

      <Card className={`${adminStyles.surface} overflow-hidden`}>
        <CardHeader>
          <CardTitle>Casamentos cadastrados</CardTitle>
          <CardDescription>
            {visibleSites.length} de {sites.length} casamentos carregados
            {cursor ? " · Carregue mais para ampliar a busca." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="owner-site-search"
            >
              Buscar casamento
              <Input
                id="owner-site-search"
                type="search"
                placeholder="Nome do casamento ou do casal"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="owner-site-lifecycle"
            >
              Status
              <select
                id="owner-site-lifecycle"
                className="h-11 rounded-lg border border-admin-line bg-admin-surface px-3 text-sm"
                value={lifecycle}
                onChange={(event) => setLifecycle(event.target.value)}
              >
                <option value="ALL">Todos</option>
                <option value="DRAFT">Rascunho</option>
                <option value="IN_REVIEW">Em revisão</option>
                <option value="ACTIVE">Ativo</option>
                <option value="INACTIVE">Inativo</option>
              </select>
            </label>
          </div>
          {loading && (
            <p role="status" className="text-sm text-admin-muted">
              Carregando casamentos…
            </p>
          )}
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
                {visibleSites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell>
                      <Link
                        className="grid gap-1 no-underline"
                        to="/sites/$siteId/home"
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
                        to="/sites/$siteId/home"
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
            {visibleSites.map((site) => (
              <Link
                className="grid gap-[7px] rounded-xl border border-admin-line bg-admin-surface p-[18px] no-underline"
                to="/sites/$siteId/home"
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
          {!loading && !error && visibleSites.length === 0 && (
            <p className="mt-6 leading-[1.6] text-admin-muted">
              {sites.length === 0
                ? "Nenhum casamento cadastrado. Comece em Novo casamento."
                : "Nenhum casamento encontrado. Ajuste a busca ou o status."}
            </p>
          )}
        </CardContent>
      </Card>

      {cursor && (
        <Button
          className="mt-[18px]"
          type="button"
          variant="outline"
          disabled={pending || loadingMore || loading}
          onClick={() => void load(cursor)}
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

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}
