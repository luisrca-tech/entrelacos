import type {
  OwnerFinanceAlert,
  OwnerFinanceSummary,
} from "@entrelacos/contracts";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../lib/apiClient";
import { AdminButton } from "./AdminButton";
import { formatCents } from "./financialFlow";
import { ToneBadge } from "./receivingUi";

const alertKindLabels: Record<OwnerFinanceAlert["kind"], string> = {
  SPLIT_DIVERGENCE_BLOCK: "Divergência no split",
  SPLIT_CANCELLED: "Split cancelado",
  ANTICIPATION_DENIED: "Antecipação negada",
  PAYMENT_RESTRICTION: "Pagamento com restrição",
  UNROUTABLE_PLATFORM_EVENT: "Evento sem destino",
  SPLIT_SETUP_FAILED: "Falha ao configurar o split",
};

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

export function formatAlertDate(value: string | null): string {
  return value === null ? "—" : dateTime.format(new Date(value));
}

export function criticalAlertCount(alerts: OwnerFinanceAlert[]): number {
  return alerts.filter((alert) => alert.severity === "critical").length;
}

type Loaded = {
  summary: OwnerFinanceSummary;
  alerts: OwnerFinanceAlert[];
};

async function load(): Promise<Loaded> {
  const [summary, list] = await Promise.all([
    apiRequest<OwnerFinanceSummary>("/v1/owner/finance/summary"),
    apiRequest<{ alerts: OwnerFinanceAlert[] }>(
      "/v1/owner/finance/alerts?status=open",
    ),
  ]);
  return { summary, alerts: list.alerts };
}

// Small count of critical open alerts for the owner menu. Fails silently.
export function OwnerFinanceAlertBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    apiRequest<{ alerts: OwnerFinanceAlert[] }>(
      "/v1/owner/finance/alerts?status=open",
    )
      .then((result) => {
        if (active) setCount(criticalAlertCount(result.alerts));
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
      <dd className="m-0 font-admin-display text-[28px] leading-[1.2] text-admin-text">
        {value}
      </dd>
      {hint && (
        <dd className="m-0 text-xs text-admin-text-secondary">{hint}</dd>
      )}
    </div>
  );
}

export function OwnerFinance() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(false);
    try {
      setData(await load());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = async (id: string) => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await apiRequest(
        `/v1/owner/finance/alerts/${encodeURIComponent(id)}/resolve`,
        {
          method: "POST",
          body: { note: note.trim() },
        },
      );
      setResolving(null);
      setNote("");
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const critical = data ? criticalAlertCount(data.alerts) : 0;
  return (
    <section aria-labelledby="owner-finance-title" className="mt-10 grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2
          id="owner-finance-title"
          className="m-0 text-[1.25rem] font-bold text-admin-text"
        >
          Financeiro da plataforma
        </h2>
        {critical > 0 && (
          <ToneBadge tone="danger">{critical} críticos</ToneBadge>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm text-admin-text-secondary">
          Não foi possível carregar o financeiro agora.{" "}
          <AdminButton type="button" tone="secondary" onClick={refresh}>
            Tentar novamente
          </AdminButton>
        </p>
      )}
      {data && (
        <>
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
            <MetricCard
              label="Comissão líquida (período)"
              value={formatCents(data.summary.platformNetCents)}
              hint={`${formatCents(data.summary.grossChargedCents)} cobrados · ${formatCents(data.summary.anticipationCents)} de antecipação`}
            />
            <MetricCard
              label="Diferença vs estimado"
              value={formatCents(data.summary.commissionDifferenceCents)}
              hint={`estimado ${formatCents(data.summary.estimatedCommissionCents)}`}
            />
          </dl>
          <div className="overflow-x-auto rounded-[18px] border border-admin-border bg-admin-surface">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="px-5 py-3.5 text-left text-[15px] font-bold text-admin-text">
                Alertas abertos
              </caption>
              <thead>
                <tr className="text-[13px] text-admin-text-secondary">
                  {[
                    "Tipo",
                    "Presente/site",
                    "Valor",
                    "Criado em",
                    "Prazo",
                    "Asaas",
                    "",
                  ].map((label) => (
                    <th
                      key={label || "action"}
                      scope="col"
                      className="px-4 py-3 font-semibold"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.alerts.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-4 text-admin-text-secondary"
                    >
                      Nenhum alerta aberto.
                    </td>
                  </tr>
                )}
                {data.alerts.map((alert) => (
                  <tr key={alert.id} className="border-t border-admin-subtle">
                    <td className="px-4 py-3">
                      <ToneBadge
                        tone={
                          alert.severity === "critical" ? "danger" : "pending"
                        }
                      >
                        {alertKindLabels[alert.kind]}
                      </ToneBadge>
                    </td>
                    <td className="px-4 py-3">
                      {alert.siteName ?? alert.siteId ?? "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {alert.amountCents === null
                        ? "—"
                        : formatCents(alert.amountCents)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatAlertDate(alert.createdAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatAlertDate(alert.dueAt)}
                    </td>
                    <td className="px-4 py-3">
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
                    </td>
                    <td className="px-4 py-3">
                      {resolving === alert.id ? (
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void resolve(alert.id);
                          }}
                        >
                          <label
                            className="sr-only"
                            htmlFor={`note-${alert.id}`}
                          >
                            Nota de resolução
                          </label>
                          <input
                            id={`note-${alert.id}`}
                            value={note}
                            maxLength={500}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="Nota"
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
