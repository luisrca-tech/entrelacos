import type {
  OwnerSiteListItem,
  ownerSiteListResponseSchema,
  SiteRecord,
} from "@entrelacos/contracts";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
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
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { formatBrazilianDate } from "./brazilianDate";
import { CreateWeddingDialog } from "./CreateWeddingDialog";
import { LoadMoreButton } from "./LoadMoreButton";
import { type PanelSessionSnapshot, panelActorOwner } from "./panelActor";

import { StatusSignal } from "./StatusSignal";

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
  const [sites, setSites] = useState<OwnerSiteListItem[]>([]);
  const [totals, setTotals] = useState<
    typeof ownerSiteListResponseSchema._output.totals | null
  >(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retryCursor, setRetryCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState("ALL");
  const alive = useRef(true);
  const busy = useRef(false);
  const refreshQueued = useRef(false);
  const loadedQuery = useRef<string | null>(null);
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
      if (busy.current || !current()) return;
      busy.current = true;
      const attempt = ++requestVersion.current;
      setError("");
      if (next) setLoadingMore(true);
      else setLoading(true);
      const filters = new URLSearchParams();
      if (search.trim()) filters.set("search", search.trim());
      if (lifecycle !== "ALL") filters.set("lifecycle", lifecycle);
      const filterKey = filters.toString();
      try {
        const query = new URLSearchParams(filters);
        if (next) query.set("cursor", next);
        const result = await apiRequest<
          typeof ownerSiteListResponseSchema._output
        >(`/v1/owner/sites${query.size ? `?${query}` : ""}`);
        if (!current(attempt)) return;
        setSites((previous) => {
          if (!next) return result.sites;
          const ids = new Set(previous.map((site) => site.id));
          return [
            ...previous,
            ...result.sites.filter((site) => !ids.has(site.id)),
          ];
        });
        loadedQuery.current = filterKey;
        setCursor(result.nextCursor);
        setTotals(result.totals);
      } catch (cause) {
        if (!current(attempt)) return;
        panelActorOwner.reportFailure(cause, snapshot.sessionEpoch);
        if (!current(attempt)) return;
        // Rows from another search or status must not appear under this one.
        if (!next && loadedQuery.current !== filterKey) {
          loadedQuery.current = null;
          setSites([]);
          setCursor(null);
        }
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
          if (refreshQueued.current) {
            refreshQueued.current = false;
            void loadRef.current();
          }
        }
      }
    },
    [current, lifecycle, search, snapshot],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  // A creation can finish while a page is loading; refresh again afterwards
  // so the new wedding is never dropped by the in-flight guard.
  const refresh = useCallback(() => {
    if (busy.current) refreshQueued.current = true;
    else void loadRef.current();
  }, []);

  useEffect(() => {
    alive.current = true;
    refreshQueued.current = false;
    setLoading(true);
    setCursor(null);
    const timeout = search.trim()
      ? setTimeout(() => void load(), 250)
      : undefined;
    if (timeout === undefined) void load();
    return () => {
      clearTimeout(timeout);
      alive.current = false;
      requestVersion.current += 1;
      busy.current = false;
    };
  }, [load, search]);

  const visibleSites = sites;
  const total = totals
    ? lifecycle === "ALL"
      ? Object.values(totals).reduce((sum, count) => sum + count, 0)
      : totals[lifecycle as SiteRecord["lifecycle"]]
    : sites.length;

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
            Casamentos cadastrados
          </h1>
          <p className="mt-[18px] max-w-[56ch] leading-[1.6] text-admin-muted">
            Escolha um casamento para organizar convites, presentes e
            recebimentos.
          </p>
        </div>
        <CreateWeddingDialog
          disabled={loading}
          current={current}
          onCreated={refresh}
          onFailure={(cause) =>
            panelActorOwner.reportFailure(cause, snapshot.sessionEpoch)
          }
          navigate={navigate}
        />
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
            disabled={loading || loadingMore}
            onClick={() => void load(retryCursor)}
          >
            Tentar novamente
          </Button>
        </div>
      )}

      <Card className={`${adminStyles.surface} overflow-hidden`}>
        <CardHeader>
          <CardDescription>
            {visibleSites.length} de {total} casamentos carregados
            {cursor ? " · Carregue mais para ampliar a busca." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 hidden flex-wrap gap-1 rounded-xl border border-admin-line bg-admin-surface p-1 lg:flex">
            {(
              [
                ["ALL", "Todos"],
                ["ACTIVE", "Ativos"],
                ["IN_REVIEW", "Em revisão"],
                ["DRAFT", "Rascunho"],
                ["INACTIVE", "Inativos"],
              ] as const
            ).map(([status, label]) => (
              <Button
                key={status}
                type="button"
                size="sm"
                variant={lifecycle === status ? "default" : "ghost"}
                aria-pressed={lifecycle === status}
                onClick={() => setLifecycle(status)}
              >
                {label}
                {totals && (
                  <span className="rounded-full bg-admin-beige px-1.5 text-xs text-admin-ink">
                    {status === "ALL"
                      ? Object.values(totals).reduce(
                          (sum, count) => sum + count,
                          0,
                        )
                      : totals[status]}
                  </span>
                )}
              </Button>
            ))}
          </div>
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
              className="grid gap-2 text-sm font-medium lg:hidden"
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
                  <TableHead>Situação</TableHead>
                  <TableHead>Site e casal</TableHead>
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
                      <StatusSignal
                        tone={
                          site.lifecycle === "ACTIVE" ? "success" : "neutral"
                        }
                      >
                        {lifecycleLabel(site.lifecycle)}
                      </StatusSignal>
                    </TableCell>
                    <TableCell>
                      <SiteAndCouple site={site} />
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
                  <StatusSignal
                    tone={site.lifecycle === "ACTIVE" ? "success" : "neutral"}
                  >
                    {lifecycleLabel(site.lifecycle)}
                  </StatusSignal>
                </div>
                <strong>{site.displayName}</strong>
                <span className="text-[0.88rem] text-admin-muted">
                  {site.coupleNames.join(" & ")}
                </span>
                <SiteAndCouple site={site} />
                <small className="mt-1 text-admin-muted">
                  {formatBrazilianDate(site.eventDate)}
                </small>
              </Link>
            ))}
          </div>
          {!loading && !error && visibleSites.length === 0 && (
            <p className="mt-6 leading-[1.6] text-admin-muted">
              {!(search.trim() || lifecycle !== "ALL")
                ? "Nenhum casamento cadastrado. Comece em Criar casamento."
                : "Nenhum casamento encontrado. Ajuste a busca ou o status."}
            </p>
          )}
        </CardContent>
      </Card>

      <LoadMoreButton
        cursor={cursor}
        onLoad={load}
        loading={loadingMore}
        disabled={loading}
        manualOnly={Boolean(error)}
        className="mt-[18px]"
      />
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

function SiteAndCouple({ site }: { site: OwnerSiteListItem }) {
  const couple = site.coupleAccess;
  return (
    <div className="grid gap-1">
      <StatusSignal tone={site.publicUrl ? "success" : "neutral"}>
        {site.publicUrl ? "Site vinculado" : "Site não vinculado"}
      </StatusSignal>
      {couple && (
        <StatusSignal
          tone={
            couple.active ? "success" : couple.pending ? "pending" : "neutral"
          }
        >
          {couple.active
            ? "Acesso ativo"
            : couple.pending
              ? "Link ativo"
              : couple.people
                ? "Link ainda não gerado"
                : "Ninguém cadastrado"}
        </StatusSignal>
      )}
    </div>
  );
}
