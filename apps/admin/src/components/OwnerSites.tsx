import type {
  OwnerSiteListItem,
  ownerSiteListResponseSchema,
  SiteRecord,
} from "@entrelacos/contracts";
import {
  Button,
  buttonVariants,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { formatBrazilianDate } from "./brazilianDate";
import { CreateWeddingDialog } from "./CreateWeddingDialog";
import { LoadMoreButton } from "./LoadMoreButton";
import { type PanelSessionSnapshot, panelActorOwner } from "./panelActor";
import { ToneBadge } from "./receivingUi";
import { StatusSignal } from "./StatusSignal";
import { lifecycleTone } from "./siteLifecyclePresentation";

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

      <div className="mb-[22px] flex flex-wrap items-center gap-3">
        <div className="hidden flex-wrap gap-1 rounded-xl border border-admin-line bg-admin-surface p-1 lg:flex">
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
              className="h-9 px-3 text-sm font-semibold"
              onClick={() => setLifecycle(status)}
            >
              {label}
              {totals && (
                <span
                  className={`rounded-full px-[7px] text-xs font-bold ${lifecycle === status ? "bg-white/20 text-white" : "bg-admin-beige text-admin-body"}`}
                >
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
        <label
          className="relative min-w-0 flex-[1_1_16rem]"
          htmlFor="owner-site-search"
        >
          <span className="sr-only">Buscar casamento</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-admin-muted"
          />
          <Input
            id="owner-site-search"
            type="search"
            placeholder="Nome do casamento ou do casal"
            className="h-11 rounded-[10px] border-admin-line-strong bg-admin-surface pl-10"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label
          className="flex min-w-0 flex-[1_1_10rem] items-center gap-2 text-sm font-medium lg:hidden"
          htmlFor="owner-site-lifecycle"
        >
          Status
          <select
            id="owner-site-lifecycle"
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-admin-line-strong bg-admin-surface px-3 text-sm"
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
        <p role="status" className="mb-4 text-sm text-admin-muted">
          Carregando casamentos…
        </p>
      )}
      <div className="overflow-hidden rounded-[18px] border border-admin-line bg-admin-surface [@media(max-width:760px)]:border-0 [@media(max-width:760px)]:bg-transparent">
        <div className="overflow-x-auto [@media(max-width:760px)]:hidden">
          <Table>
            <TableHeader className="bg-admin-canvas">
              <TableRow>
                <TableHead className="px-[22px]">Casamento</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Recebimentos</TableHead>
                <TableHead>Site e casal</TableHead>
                <TableHead aria-label="Ação" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleSites.map((site) => (
                <TableRow key={site.id}>
                  <TableCell className="px-[22px] py-3.5">
                    <div className="grid gap-[3px]">
                      <strong className="text-[15px] text-admin-graphite">
                        {site.displayName}
                      </strong>
                      <span className="text-[13px] text-admin-muted">
                        {site.coupleNames.join(" & ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-admin-body">
                    {formatBrazilianDate(site.eventDate)}
                  </TableCell>
                  <TableCell>
                    <LifecycleBadge lifecycle={site.lifecycle} />
                  </TableCell>
                  <TableCell>
                    <ReceivingAccountBadge state={site.receivingAccount} />
                  </TableCell>
                  <TableCell>
                    <SiteAndCouple site={site} />
                  </TableCell>
                  <TableCell className="pr-[22px] text-right">
                    <Link
                      className={openAction}
                      data-variant="outline"
                      to="/sites/$siteId/home"
                      params={{ siteId: site.id }}
                      aria-label={`Abrir ${site.displayName}`}
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
              <div className="flex flex-wrap items-start justify-between gap-2">
                <strong className="min-w-0 break-words text-admin-graphite">
                  {site.displayName}
                </strong>
                <LifecycleBadge lifecycle={site.lifecycle} />
              </div>
              <span className="text-[0.88rem] text-admin-muted">
                {site.coupleNames.join(" & ")} ·{" "}
                {formatBrazilianDate(site.eventDate)}
              </span>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-admin-muted">
                Recebimentos
                <ReceivingAccountBadge state={site.receivingAccount} />
              </div>
              <SiteAndCouple site={site} />
            </Link>
          ))}
        </div>
        {!loading && !error && visibleSites.length === 0 && (
          <p className="m-0 p-[22px] leading-[1.6] text-admin-muted">
            {!(search.trim() || lifecycle !== "ALL")
              ? "Nenhum casamento cadastrado. Comece em Criar casamento."
              : "Nenhum casamento encontrado. Ajuste a busca ou o status."}
          </p>
        )}
        <div
          data-slot="owner-sites-footer"
          className="flex flex-wrap items-center justify-between gap-3 border-t border-admin-line px-[22px] py-3.5 [@media(max-width:760px)]:mt-2.5 [@media(max-width:760px)]:rounded-xl [@media(max-width:760px)]:border [@media(max-width:760px)]:bg-admin-surface [@media(max-width:760px)]:px-[18px]"
        >
          <p className="m-0 text-[13px] text-admin-muted">
            {visibleSites.length} de {total} casamentos carregados
            {cursor ? " · Carregue mais para ampliar a busca." : ""}
          </p>
          <LoadMoreButton
            cursor={cursor}
            onLoad={load}
            loading={loadingMore}
            disabled={loading}
            manualOnly={Boolean(error)}
            className="h-[38px] rounded-[10px] border-admin-line-strong px-6 font-semibold text-admin-graphite"
          />
        </div>
      </div>
    </div>
  );
}

const openAction = `${buttonVariants({ variant: "outline" })} h-[38px] rounded-[10px] border-admin-line-strong bg-admin-surface px-6 text-[15px] font-semibold text-admin-graphite no-underline`;

function LifecycleBadge({ lifecycle }: { lifecycle: SiteRecord["lifecycle"] }) {
  return (
    <ToneBadge tone={lifecycleTone[lifecycle]}>
      {lifecycleLabel(lifecycle)}
    </ToneBadge>
  );
}

// Stored account existence only; readiness is shown inside each wedding.
function ReceivingAccountBadge({
  state,
}: {
  state: OwnerSiteListItem["receivingAccount"] | undefined;
}) {
  return state === "CREATED" ? (
    <ToneBadge tone="success">Conta criada</ToneBadge>
  ) : state === "MISSING" ? (
    <ToneBadge tone="neutral">Sem conta</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">Desativado</ToneBadge>
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
