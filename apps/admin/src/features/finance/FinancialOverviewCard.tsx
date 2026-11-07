import {
  type FinancialOverview,
  financialOverviewSchema,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { AdminButton } from "../../components/AdminButton";
import {
  type FinancialFlowSegmentId,
  financialFlow,
  formatCents,
} from "../../components/financialFlow";
import {
  readyCard,
  readyCardTitle,
  readyLabel,
  readyQuietButton,
} from "../../components/receivingUi";

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

export function canReadOverview(siteId: string, access: SiteAccess | null) {
  const parsedAccess = siteAccessSchema.safeParse(access);
  return (
    parsedAccess.success &&
    parsedAccess.data.siteId === siteId &&
    ((parsedAccess.data.membershipRole === "SITE_ADMIN" &&
      parsedAccess.data.membershipId !== null) ||
      (parsedAccess.data.membershipRole === "OWNER" &&
        parsedAccess.data.membershipId === null &&
        !parsedAccess.data.capabilities.configureReceiving &&
        !parsedAccess.data.capabilities.requestWithdrawal)) &&
    parsedAccess.data.capabilities.readFinance
  );
}

// Returns the overview only when it is valid for this site and the reader.
export function currentOverview(
  siteId: string,
  access: SiteAccess | null,
  overview: FinancialOverview | null,
) {
  if (!canReadOverview(siteId, access)) return null;
  const parsed = financialOverviewSchema.safeParse(overview);
  return parsed.success && parsed.data.siteId === siteId ? parsed.data : null;
}

export const segmentColors: Record<FinancialFlowSegmentId, string> = {
  awaiting: "bg-admin-pending/50",
  fees: "bg-admin-border-strong",
  withdrawn: "bg-admin-text",
  pending: "bg-admin-pending",
  refunded: "bg-admin-danger",
  available: "bg-admin-success",
};

export function OverviewNotice({
  title,
  children,
  role = "status",
}: {
  title: string;
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <section
      aria-labelledby="financial-overview-title"
      className={`${readyCard} grid gap-3 px-7 py-6 [@media(max-width:760px)]:px-5`}
    >
      <h2 id="financial-overview-title" className={readyCardTitle}>
        {title}
      </h2>
      <div role={role} className="grid gap-3 text-[15px] text-admin-text">
        {children}
      </div>
    </section>
  );
}

// The available balance, or an explicit unavailable state: never R$ 0,00.
export function BalanceFigure({
  overview,
  size = "lg",
}: {
  overview: FinancialOverview;
  size?: "lg" | "md";
}) {
  const known =
    overview.availability === "CURRENT" && overview.availableCents !== null;
  const figure =
    size === "lg"
      ? "text-[clamp(2.5rem,6vw,3.25rem)]"
      : "text-[clamp(2.25rem,5vw,3rem)]";
  return known ? (
    <p
      className={`m-0 font-admin-display leading-none font-normal text-admin-success-text ${figure}`}
    >
      {formatCents(overview.availableCents as number)}
    </p>
  ) : (
    <div className="grid gap-1.5">
      <p
        className={`m-0 font-admin-display text-[clamp(1.75rem,4vw,2.25rem)] leading-none font-normal text-admin-text-secondary`}
      >
        Saldo indisponível
      </p>
      <p role="status" className="m-0 text-sm text-admin-text-secondary">
        {overview.availability === "STALE"
          ? "Saldo desatualizado. Aguarde uma nova confirmação para solicitar uma transferência."
          : "Ainda não confirmado pelo Asaas."}
      </p>
    </div>
  );
}

export function FinancialOverviewCard({
  siteId,
  access,
  overview,
  loading = false,
  error = false,
  onRetry,
  withdrawAction,
  paymentsLink,
}: {
  siteId: string;
  access: SiteAccess | null;
  overview: FinancialOverview | null;
  loading?: boolean;
  error?: boolean;
  onRetry: () => void;
  withdrawAction?: ReactNode;
  paymentsLink?: ReactNode;
}) {
  if (!canReadOverview(siteId, access))
    return (
      <OverviewNotice title="Acesso financeiro restrito">
        <p className="m-0">
          Apenas os administradores autorizados deste casamento podem consultar
          valores e movimentações.
        </p>
      </OverviewNotice>
    );
  if (loading)
    return (
      <OverviewNotice title="Consultando o saldo">
        <p className="m-0">
          Aguarde enquanto consultamos os valores deste casamento.
        </p>
      </OverviewNotice>
    );
  const current = error ? null : currentOverview(siteId, access, overview);
  if (!current)
    return (
      <OverviewNotice
        title="Resumo financeiro indisponível"
        role={error ? "alert" : "status"}
      >
        <p className="m-0">
          Não há um saldo confirmado para exibir. Os recebimentos e as
          movimentações dependem da confirmação do Asaas.
        </p>
        {error && (
          <div>
            <AdminButton type="button" tone="secondary" onClick={onRetry}>
              Tentar novamente
            </AdminButton>
          </div>
        )}
      </OverviewNotice>
    );
  const flow = financialFlow(current);
  const synchronizedAt =
    current.availability === "CURRENT" ? current.synchronizedAt : null;
  return (
    <div className="grid min-w-0 gap-5">
      {showSandboxNotice(current.mode) && (
        <p className="m-0 text-sm text-admin-text-secondary">
          Sandbox — valores de teste, sem movimentação de dinheiro real.
        </p>
      )}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="financial-balance-title"
          className={`${readyCard} grid content-start gap-3.5 px-7 py-[26px] [@media(max-width:760px)]:px-5`}
        >
          <h2 id="financial-balance-title" className={readyLabel}>
            Disponível para saque
          </h2>
          <BalanceFigure overview={current} />
          {current.awaitingReleaseCents > 0 && (
            <p className="m-0 text-sm leading-[1.55] text-admin-text">
              Mais <strong>{formatCents(current.awaitingReleaseCents)}</strong>{" "}
              aguardando liberação do Asaas. Pagamentos com cartão ficam
              disponíveis conforme a liberação de cada parcela.
            </p>
          )}
          {(current.platformAdjustmentOwedCents ?? 0) > 0 && (
            <p className="m-0 text-sm leading-[1.55] text-admin-text">
              O EntreLaços vai creditar{" "}
              <strong>
                {formatCents(current.platformAdjustmentOwedCents ?? 0)}
              </strong>{" "}
              para cobrir diferenças de tarifa.
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            {withdrawAction}
            {synchronizedAt ? (
              <button
                type="button"
                className={readyQuietButton}
                onClick={onRetry}
                aria-label={`Atualizar saldo. Atualizado às ${timeFormatter.format(new Date(synchronizedAt))}`}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                <span>
                  Atualizado às{" "}
                  <time dateTime={synchronizedAt}>
                    {timeFormatter.format(new Date(synchronizedAt))}
                  </time>
                </span>
              </button>
            ) : (
              <button
                type="button"
                className={readyQuietButton}
                onClick={onRetry}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Atualizar
              </button>
            )}
          </div>
        </section>
        <section
          aria-labelledby="financial-received-title"
          className={`${readyCard} grid content-start gap-2.5 px-7 py-[26px] [@media(max-width:760px)]:px-5 lg:grid-rows-[auto_auto_auto_1fr_auto]`}
        >
          <h2 id="financial-received-title" className={readyLabel}>
            Presentes recebidos
          </h2>
          <p className="m-0 font-admin-display text-[2.5rem] leading-none font-normal text-admin-text">
            {formatCents(flow.releasedGrossCents)}
          </p>
          <p className="m-0 text-sm leading-[1.5] text-admin-text">
            pagos pelos convidados em presentes já liberados.
            {current.awaitingReleaseCents > 0 && (
              <>
                {" "}
                Mais {formatCents(current.awaitingReleaseCents)}, já sem as
                taxas, aguardando liberação.
              </>
            )}
          </p>
          <span aria-hidden="true" />
          {paymentsLink}
        </section>
      </div>
      <FinancialFlowCard overview={current} />
    </div>
  );
}

export function FinancialFlowCard({
  overview,
}: {
  overview: FinancialOverview;
}) {
  const flow = financialFlow(overview);
  const visible = flow.segments.filter(({ cents }) => cents > 0);
  return (
    <section
      aria-labelledby="financial-flow-title"
      className={`${readyCard} grid gap-4 px-7 py-6 [@media(max-width:760px)]:px-5`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="financial-flow-title" className={readyCardTitle}>
          Para onde foi o dinheiro
        </h2>
        <p className="m-0 text-[13px] text-admin-text-secondary">
          Total acompanhado: {formatCents(flow.totalCents)}
        </p>
      </div>
      <div
        role="img"
        aria-label={`Distribuição: ${flow.segments.map(({ label, cents }) => `${label.toLowerCase()} ${formatCents(cents)}`).join("; ")}`}
        className="flex h-[18px] w-full gap-0.5 overflow-hidden rounded-full bg-admin-subtle"
      >
        {visible.map((segment) => (
          <span
            key={segment.id}
            className={`h-full min-w-2 ${segmentColors[segment.id]}`}
            style={{ flexGrow: segment.cents, flexBasis: 0 }}
          />
        ))}
      </div>
      <dl className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-x-6 gap-y-3">
        {flow.segments.map((segment) => (
          <div key={segment.id} className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className={`mt-[3px] size-3 shrink-0 rounded-[3px] ${segmentColors[segment.id]}`}
            />
            <div className="grid min-w-0 gap-0.5">
              <dt className="text-[13px] text-admin-text-secondary">
                {segment.label}
              </dt>
              <dd
                className={`m-0 text-[15px] font-bold ${segment.id === "available" ? "text-admin-success-text" : "text-admin-text"}`}
              >
                {formatCents(segment.cents)}
              </dd>
            </div>
          </div>
        ))}
        {flow.availableCents === null && (
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="mt-[3px] size-3 shrink-0 rounded-[3px] border border-dashed border-admin-border-strong"
            />
            <div className="grid min-w-0 gap-0.5">
              <dt className="text-[13px] text-admin-text-secondary">
                Disponível para saque
              </dt>
              <dd className="m-0 text-[15px] font-bold text-admin-text-secondary">
                Indisponível
              </dd>
            </div>
          </div>
        )}
      </dl>
    </section>
  );
}
