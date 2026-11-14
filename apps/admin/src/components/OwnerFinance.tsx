import type {
  OwnerFinanceAlert,
  OwnerFinanceAlertListResponse,
  OwnerFinanceGift,
  OwnerFinanceGiftListResponse,
  OwnerFinanceGiftStatus,
  OwnerFinanceSiteListResponse,
  OwnerFinanceSummary,
} from "@entrelacos/contracts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@entrelacos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { AdminButton } from "./AdminButton";
import { formatCents } from "./financialFlow";
import { LoadMoreButton } from "./LoadMoreButton";
import { ToneBadge, type ToneName } from "./receivingUi";

const alertKindLabels: Record<OwnerFinanceAlert["kind"], string> = {
  SPLIT_DIVERGENCE_BLOCK: "Divergência no split",
  SPLIT_CANCELLED: "Split cancelado",
  ANTICIPATION_DENIED: "Antecipação negada",
  PAYMENT_RESTRICTION: "Pagamento com restrição",
  UNROUTABLE_PLATFORM_EVENT: "Evento sem destino",
  SPLIT_SETUP_FAILED: "Falha ao configurar o split",
};

export const giftStatusLabels: Record<OwnerFinanceGiftStatus, string> = {
  AWAITING_RELEASE: "Aguardando liberação",
  PARTIALLY_RECEIVED: "Recebido parcialmente",
  RECEIVED: "Recebido",
  IN_REVIEW: "Em análise",
};

const giftStatusTone: Record<OwnerFinanceGiftStatus, ToneName> = {
  AWAITING_RELEASE: "neutral",
  PARTIALLY_RECEIVED: "pending",
  RECEIVED: "success",
  IN_REVIEW: "danger",
};

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

export function formatAlertDate(value: string | null): string {
  return value === null ? "—" : dateTime.format(new Date(value));
}

export function formatPaymentMethod(
  gift: Pick<OwnerFinanceGift, "method" | "installmentCount">,
): string {
  return gift.method === "PIX" ? "Pix" : `Cartão ${gift.installmentCount}x`;
}

export interface GiftFilters {
  siteIds: string[];
  /** `YYYY-MM-DD` dates in Brasília time; empty means open-ended. */
  from: string;
  to: string;
  method: "" | OwnerFinanceGift["method"];
  status: "" | OwnerFinanceGiftStatus;
}

export const emptyGiftFilters: GiftFilters = {
  siteIds: [],
  from: "",
  to: "",
  method: "",
  status: "",
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Query string shared by the gift table and its totals. */
export function giftFilterParams(filters: GiftFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const siteId of filters.siteIds) params.append("siteId", siteId);
  // Brasília has no daylight saving time: whole days are -03:00.
  if (datePattern.test(filters.from))
    params.set("from", `${filters.from}T00:00:00.000-03:00`);
  if (datePattern.test(filters.to))
    params.set("to", `${filters.to}T23:59:59.999-03:00`);
  if (filters.method) params.set("method", filters.method);
  if (filters.status) params.set("status", filters.status);
  return params;
}

export function alertListPath(input: {
  status: "open" | "resolved" | "all";
  siteIds: string[];
  cursor?: string;
  limit?: number;
}): string {
  const params = new URLSearchParams({ status: input.status });
  for (const siteId of input.siteIds) params.append("siteId", siteId);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  return `/v1/owner/finance/alerts?${params}`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

// Count of critical open alerts for the owner menu. Fails silently.
export function OwnerFinanceAlertBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    apiRequest<OwnerFinanceAlertListResponse>(
      alertListPath({ status: "open", siteIds: [], limit: 1 }),
    )
      .then((result) => {
        if (active) setCount(result.criticalOpenCount);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (count === 0) return null;
  return (
    <span
      role="status"
      aria-label={`${count} alertas críticos em aberto`}
      className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-admin-danger-subtle px-1.5 text-xs font-bold text-admin-danger-text"
    >
      {count}
    </span>
  );
}

const fieldClass =
  "h-11 min-w-0 rounded-[10px] border border-admin-border-strong bg-admin-surface px-3 text-sm text-admin-text";

function SiteFilter({
  sites,
  selected,
  onChange,
  id,
}: {
  sites: OwnerFinanceSiteListResponse["sites"];
  selected: string[];
  onChange: (siteIds: string[]) => void;
  id: string;
}) {
  const label =
    selected.length === 0
      ? "Todos os casamentos"
      : selected.length === 1
        ? (sites.find((site) => site.id === selected[0])?.name ?? "1 casamento")
        : `${selected.length} casamentos`;
  return (
    <div className="grid min-w-0 gap-1.5 text-sm font-medium">
      <span id={`${id}-label`}>Casamentos</span>
      <Popover>
        <PopoverTrigger
          aria-labelledby={`${id}-label`}
          className={`${fieldClass} truncate text-left`}
          render={<button type="button" />}
        >
          {label}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-10 grid max-h-80 w-[min(320px,calc(100vw-32px))] gap-1 overflow-y-auto rounded-[14px] border border-admin-border bg-admin-surface p-3 shadow-admin"
        >
          <fieldset className="m-0 grid gap-1 border-0 p-0">
            <legend className="sr-only">Filtrar por casamento</legend>
            {sites.length === 0 && (
              <p className="m-0 text-sm text-admin-text-secondary">
                Nenhum casamento cadastrado.
              </p>
            )}
            {sites.map((site) => (
              <label
                key={site.id}
                className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-admin-subtle"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(site.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, site.id]
                        : selected.filter((value) => value !== site.id),
                    )
                  }
                />
                <span className="min-w-0 truncate">{site.name}</span>
              </label>
            ))}
          </fieldset>
          {selected.length > 0 && (
            <AdminButton
              type="button"
              size="sm"
              tone="ghost"
              className="mt-1 w-fit"
              onClick={() => onChange([])}
            >
              Limpar seleção
            </AdminButton>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-0.5 rounded-[14px] border border-admin-border bg-admin-surface px-[18px] py-4">
      <dt className="text-[13px] text-admin-text-secondary">{label}</dt>
      <dd className="m-0 font-admin-display text-[26px] leading-[1.2] text-admin-text">
        {value}
      </dd>
      {hint && (
        <dd className="m-0 text-xs text-admin-text-secondary">{hint}</dd>
      )}
    </div>
  );
}

function ErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid gap-3 rounded-xl border border-admin-border bg-admin-surface p-5">
      <p role="alert" className="m-0 text-sm text-admin-text-secondary">
        Não foi possível carregar os dados agora.
      </p>
      <AdminButton
        type="button"
        tone="secondary"
        className="w-fit"
        onClick={onRetry}
      >
        Tentar novamente
      </AdminButton>
    </div>
  );
}

function coupleCredit(gift: OwnerFinanceGift): string {
  return gift.coupleCreditedCents === gift.coupleExpectedCents
    ? formatCents(gift.coupleCreditedCents)
    : `${formatCents(gift.coupleCreditedCents)} de ${formatCents(gift.coupleExpectedCents)}`;
}

function GiftsPanel({
  sites,
}: {
  sites: OwnerFinanceSiteListResponse["sites"];
}) {
  const [filters, setFilters] = useState<GiftFilters>(emptyGiftFilters);
  const [summary, setSummary] = useState<OwnerFinanceSummary | null>(null);
  const [gifts, setGifts] = useState<OwnerFinanceGift[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (current: GiftFilters) => {
    const id = ++request.current;
    setLoading(true);
    setError(false);
    const params = giftFilterParams(current);
    try {
      const [totals, page] = await Promise.all([
        apiRequest<OwnerFinanceSummary>(
          withQuery("/v1/owner/finance/summary", params),
        ),
        apiRequest<OwnerFinanceGiftListResponse>(
          withQuery("/v1/owner/finance/gifts", params),
        ),
      ]);
      if (id !== request.current) return;
      setSummary(totals);
      setGifts(page.gifts);
      setCursor(page.nextCursor);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (filters.from && filters.to && filters.from > filters.to) return;
    void load(filters);
  }, [filters, load]);

  const loadMore = async (next: string) => {
    const id = request.current;
    setLoadingMore(true);
    const params = giftFilterParams(filters);
    params.set("cursor", next);
    try {
      const page = await apiRequest<OwnerFinanceGiftListResponse>(
        withQuery("/v1/owner/finance/gifts", params),
      );
      if (id !== request.current) return;
      setGifts((current) => [...current, ...page.gifts]);
      setCursor(page.nextCursor);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const update = (patch: Partial<GiftFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const invalidPeriod =
    filters.from !== "" && filters.to !== "" && filters.from > filters.to;

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] items-end gap-3">
        <SiteFilter
          id="finance-gift-sites"
          sites={sites}
          selected={filters.siteIds}
          onChange={(siteIds) => update({ siteIds })}
        />
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          De
          <input
            type="date"
            className={fieldClass}
            value={filters.from}
            onChange={(event) => update({ from: event.target.value })}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Até
          <input
            type="date"
            className={fieldClass}
            value={filters.to}
            onChange={(event) => update({ to: event.target.value })}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Forma de pagamento
          <select
            className={fieldClass}
            value={filters.method}
            onChange={(event) =>
              update({ method: event.target.value as GiftFilters["method"] })
            }
          >
            <option value="">Todas</option>
            <option value="PIX">Pix</option>
            <option value="CREDIT_CARD">Cartão</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Situação
          <select
            className={fieldClass}
            value={filters.status}
            onChange={(event) =>
              update({ status: event.target.value as GiftFilters["status"] })
            }
          >
            <option value="">Todas</option>
            {Object.entries(giftStatusLabels).map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {invalidPeriod && (
        <p role="alert" className={`m-0 ${adminStyles.alert}`}>
          A data inicial precisa ser anterior à final.
        </p>
      )}
      {error && !invalidPeriod && (
        <ErrorNotice onRetry={() => void load(filters)} />
      )}

      {summary && (
        <dl
          aria-label="Totais do filtro"
          className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3"
        >
          <MetricCard
            label="Cobrado dos convidados"
            value={formatCents(summary.grossChargedCents)}
            hint={`${summary.giftCount} ${summary.giftCount === 1 ? "presente" : "presentes"}`}
          />
          <MetricCard
            label="Repassado ao casal"
            value={formatCents(summary.coupleCreditedCents)}
          />
          <MetricCard
            label="Comissão estimada"
            value={formatCents(summary.estimatedCommissionCents)}
          />
          <MetricCard
            label="Comissão líquida real"
            value={formatCents(summary.netCommissionCents)}
          />
          <MetricCard
            label="Diferença"
            value={formatCents(summary.commissionDifferenceCents)}
            hint="Estimada menos real, nos presentes recebidos"
          />
        </dl>
      )}

      {loading && (
        <p role="status" className="m-0 text-sm text-admin-text-secondary">
          Carregando presentes…
        </p>
      )}
      <div className="overflow-x-auto rounded-[18px] border border-admin-border bg-admin-surface">
        <Table>
          <TableHeader className="bg-admin-canvas">
            <TableRow>
              <TableHead className="px-4">Data</TableHead>
              <TableHead>Casamento</TableHead>
              <TableHead>Presente</TableHead>
              <TableHead>Pagamento</TableHead>
              <TableHead className="text-right">Pago pelo convidado</TableHead>
              <TableHead className="text-right">Repassado ao casal</TableHead>
              <TableHead className="text-right">Comissão estimada</TableHead>
              <TableHead className="text-right">Comissão líquida</TableHead>
              <TableHead className="pr-4">Situação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && gifts.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="px-4 py-5 text-admin-text-secondary"
                >
                  Nenhum presente pago encontrado com estes filtros.
                </TableCell>
              </TableRow>
            )}
            {gifts.map((gift) => (
              <TableRow key={gift.orderId}>
                <TableCell className="px-4 whitespace-nowrap">
                  {formatAlertDate(gift.paidAt)}
                </TableCell>
                <TableCell>
                  {gift.siteName}
                  {gift.environment === "sandbox" && (
                    <span className="ml-2 text-xs text-admin-text-secondary">
                      sandbox
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">
                  {gift.giftTitle}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatPaymentMethod(gift)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatCents(gift.grossCents)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {coupleCredit(gift)}
                  {gift.installmentCount > 1 && (
                    <span className="block text-xs text-admin-text-secondary">
                      {gift.creditedInstallments}/{gift.installmentCount}{" "}
                      parcelas
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatCents(gift.estimatedCommissionCents)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {gift.netCommissionCents === null
                    ? "—"
                    : formatCents(gift.netCommissionCents)}
                </TableCell>
                <TableCell className="pr-4">
                  <ToneBadge tone={giftStatusTone[gift.status]}>
                    {giftStatusLabels[gift.status]}
                  </ToneBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <LoadMoreButton
        cursor={loading ? null : cursor}
        loading={loadingMore}
        manualOnly
        className="w-fit"
        onLoad={loadMore}
      />
    </div>
  );
}

function AlertsPanel({
  sites,
  onChanged,
}: {
  sites: OwnerFinanceSiteListResponse["sites"];
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<OwnerFinanceAlert[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(false);
    try {
      const page = await apiRequest<OwnerFinanceAlertListResponse>(
        alertListPath({ status, siteIds }),
      );
      if (id !== request.current) return;
      setAlerts(page.alerts);
      setCursor(page.nextCursor);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [status, siteIds]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (next: string) => {
    const id = request.current;
    setLoadingMore(true);
    try {
      const page = await apiRequest<OwnerFinanceAlertListResponse>(
        alertListPath({ status, siteIds, cursor: next }),
      );
      if (id !== request.current) return;
      setAlerts((current) => [...current, ...page.alerts]);
      setCursor(page.nextCursor);
    } catch {
      if (id === request.current) setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const resolve = async (id: string) => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await apiRequest(
        `/v1/owner/finance/alerts/${encodeURIComponent(id)}/resolve`,
        { method: "POST", body: { note: note.trim() } },
      );
      setResolving(null);
      setNote("");
      onChanged();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <SiteFilter
            id="finance-alert-sites"
            sites={sites}
            selected={siteIds}
            onChange={setSiteIds}
          />
        </div>
        <fieldset className="m-0 flex flex-wrap gap-1 rounded-xl border border-admin-border bg-admin-surface p-1">
          <legend className="sr-only">Situação dos alertas</legend>
          {(
            [
              ["open", "Abertos"],
              ["resolved", "Resolvidos"],
              ["all", "Todos"],
            ] as const
          ).map(([value, label]) => (
            <AdminButton
              key={value}
              type="button"
              size="sm"
              tone="ghost"
              aria-pressed={status === value}
              className={`h-9 px-3 text-sm font-semibold ${status === value ? adminStyles.selected : "text-admin-text-secondary"}`}
              onClick={() => setStatus(value)}
            >
              {label}
            </AdminButton>
          ))}
        </fieldset>
      </div>
      {error && <ErrorNotice onRetry={() => void load()} />}
      {loading && (
        <p role="status" className="m-0 text-sm text-admin-text-secondary">
          Carregando alertas…
        </p>
      )}
      <div className="overflow-x-auto rounded-[18px] border border-admin-border bg-admin-surface">
        <Table>
          <TableHeader className="bg-admin-canvas">
            <TableRow>
              <TableHead className="px-4">Tipo</TableHead>
              <TableHead>Casamento</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Criado em</TableHead>
              <TableHead>Prazo</TableHead>
              <TableHead>Asaas</TableHead>
              <TableHead className="pr-4">Resolução</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && alerts.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="px-4 py-5 text-admin-text-secondary"
                >
                  Nenhum alerta encontrado.
                </TableCell>
              </TableRow>
            )}
            {alerts.map((alert) => (
              <TableRow key={alert.id}>
                <TableCell className="px-4">
                  <ToneBadge
                    tone={alert.severity === "critical" ? "danger" : "pending"}
                  >
                    {alertKindLabels[alert.kind]}
                  </ToneBadge>
                </TableCell>
                <TableCell>{alert.siteName ?? "—"}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {alert.amountCents === null
                    ? "—"
                    : formatCents(alert.amountCents)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatAlertDate(alert.createdAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatAlertDate(alert.dueAt)}
                </TableCell>
                <TableCell>
                  {alert.asaasPaymentUrl ? (
                    <a
                      href={alert.asaasPaymentUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-admin-accent-hover"
                    >
                      Abrir no Asaas
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="pr-4">
                  {alert.resolvedAt ? (
                    <span className="grid gap-0.5 text-sm">
                      <span>{formatAlertDate(alert.resolvedAt)}</span>
                      {alert.resolvedNote && (
                        <span className="text-admin-text-secondary">
                          {alert.resolvedNote}
                        </span>
                      )}
                    </span>
                  ) : resolving === alert.id ? (
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void resolve(alert.id);
                      }}
                    >
                      <label className="sr-only" htmlFor={`note-${alert.id}`}>
                        Nota de resolução
                      </label>
                      <input
                        id={`note-${alert.id}`}
                        value={note}
                        maxLength={500}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="O que foi feito"
                        className="h-9 rounded-lg border border-admin-border-strong bg-admin-surface px-2"
                      />
                      <AdminButton
                        type="submit"
                        tone="primary"
                        size="sm"
                        disabled={busy || !note.trim()}
                      >
                        Confirmar
                      </AdminButton>
                    </form>
                  ) : (
                    <AdminButton
                      type="button"
                      size="sm"
                      tone="secondary"
                      onClick={() => {
                        setResolving(alert.id);
                        setNote("");
                      }}
                    >
                      Marcar resolvido
                    </AdminButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <LoadMoreButton
        cursor={loading ? null : cursor}
        loading={loadingMore}
        manualOnly
        className="w-fit"
        onLoad={loadMore}
      />
    </div>
  );
}

export function OwnerFinance() {
  const [tab, setTab] = useState<"gifts" | "alerts">("gifts");
  const [sites, setSites] = useState<OwnerFinanceSiteListResponse["sites"]>([]);
  const [openAlerts, setOpenAlerts] = useState<{
    open: number;
    critical: number;
  } | null>(null);

  const loadAlertCounts = useCallback(() => {
    apiRequest<OwnerFinanceAlertListResponse>(
      alertListPath({ status: "open", siteIds: [], limit: 1 }),
    )
      .then((result) =>
        setOpenAlerts({
          open: result.openCount,
          critical: result.criticalOpenCount,
        }),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<OwnerFinanceSiteListResponse>("/v1/owner/finance/sites")
      .then((result) => {
        if (active) setSites(result.sites);
      })
      .catch(() => {});
    loadAlertCounts();
    return () => {
      active = false;
    };
  }, [loadAlertCounts]);

  return (
    <div>
      <section className="mb-6">
        <p className="m-0 mb-3.5 text-[0.7rem] font-bold uppercase tracking-[0.13em] leading-[1.3] text-admin-text-secondary">
          Painel EntreLaços
        </p>
        <h1
          className={`m-0 max-w-none text-[clamp(1.85rem,3vw,2.6rem)] ${displayHeading}`}
        >
          Financeiro Entrelaços
        </h1>
        <p className="mt-[18px] max-w-[60ch] leading-[1.6] text-admin-text-secondary">
          Presentes pagos no split da conta da plataforma, com o que foi
          repassado a cada casal e a comissão efetivamente recebida.
        </p>
      </section>
      <div
        role="tablist"
        aria-label="Financeiro"
        className="mb-5 flex w-fit flex-wrap gap-1 rounded-xl border border-admin-border bg-admin-surface p-1"
      >
        {(
          [
            ["gifts", "Presentes pagos"],
            ["alerts", "Alertas"],
          ] as const
        ).map(([value, label]) => (
          <AdminButton
            key={value}
            type="button"
            role="tab"
            size="sm"
            tone="ghost"
            aria-selected={tab === value}
            className={`h-9 px-3 text-sm font-semibold ${tab === value ? adminStyles.selected : "text-admin-text-secondary"}`}
            onClick={() => setTab(value)}
          >
            {label}
            {value === "alerts" && openAlerts && openAlerts.open > 0 && (
              <span
                className={`rounded-full px-[7px] text-xs font-bold ${openAlerts.critical > 0 ? "bg-admin-danger-subtle text-admin-danger-text" : "bg-admin-subtle text-admin-text"}`}
              >
                {openAlerts.open}
              </span>
            )}
          </AdminButton>
        ))}
      </div>
      <div
        role="tabpanel"
        aria-label={tab === "gifts" ? "Presentes pagos" : "Alertas"}
      >
        {tab === "gifts" ? (
          <GiftsPanel sites={sites} />
        ) : (
          <AlertsPanel sites={sites} onChanged={loadAlertCounts} />
        )}
      </div>
    </div>
  );
}
