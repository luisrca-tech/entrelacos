import type { SiteAccess, WithdrawalIntent } from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { canReadFinancialOverview } from "./financialOverview";
import { LoadMoreButton } from "./LoadMoreButton";
import {
  readyCard,
  readyCardTitle,
  readyQuietButton,
  ToneBadge,
  type ToneName,
} from "./receivingUi";
import { withdrawalAmountRows } from "./withdrawalAmountRows";
import type { WithdrawalHistoryResult } from "./withdrawalHistory";
import { parseWithdrawalHistory } from "./withdrawalHistory";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const stateLabels: Record<WithdrawalIntent["state"], string> = {
  REQUESTED: "Solicitado",
  AWAITING_AUTHORIZATION: "Aguardando autorização",
  PROCESSING: "Em processamento",
  COMPLETED: "Concluído pelo provedor",
  FAILED: "Falha informada",
  CANCELLED: "Cancelado",
  UNKNOWN: "Resultado em verificação",
};
const badges: Record<WithdrawalIntent["state"], [string, ToneName]> = {
  REQUESTED: ["Solicitado", "pending"],
  AWAITING_AUTHORIZATION: ["Aguardando autorização", "pending"],
  PROCESSING: ["Em processamento", "pending"],
  COMPLETED: ["Concluído", "success"],
  FAILED: ["Não concluído", "danger"],
  CANCELLED: ["Cancelado", "neutral"],
  UNKNOWN: ["Em verificação", "pending"],
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Data indisponível"
    : dateFormatter.format(date);
}
function netAmount(withdrawal: WithdrawalIntent) {
  return currency.format(
    (withdrawal.settlement?.netCents ?? withdrawal.netCents) / 100,
  );
}

export function WithdrawalStateBadge({
  state,
}: {
  state: WithdrawalIntent["state"];
}) {
  const [label, tone] = badges[state];
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

function WithdrawalRecord({ withdrawal }: { withdrawal: WithdrawalIntent }) {
  return (
    <li className="border-t border-admin-beige px-6 py-4 [@media(max-width:760px)]:px-5">
      <details className="group">
        <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-[18px] gap-y-2 [&::-webkit-details-marker]:hidden">
          <span className="grid min-w-0 flex-[1_1_12rem] gap-0.5">
            <strong className="text-[15px] text-admin-ink">
              {netAmount(withdrawal)}
            </strong>
            <span className="text-[13px] text-admin-muted">
              <time dateTime={withdrawal.createdAt}>
                {formatDate(withdrawal.createdAt)}
              </time>
            </span>
          </span>
          <WithdrawalStateBadge state={withdrawal.state} />
          <span className="text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4">
            <span className="group-open:hidden">Detalhes</span>
            <span className="hidden group-open:inline">Ocultar detalhes</span>
          </span>
        </summary>
        <div className="mt-3 grid gap-3 rounded-xl bg-admin-canvas px-4 py-3.5 text-sm">
          {showSandboxNotice(withdrawal.mode) && (
            <p className="m-0 text-admin-muted">
              Sandbox — valores de teste, sem movimentação de dinheiro real.
            </p>
          )}
          <dl className="m-0 grid gap-2">
            {[
              ...withdrawalAmountRows(withdrawal).map(([label, cents]) => [
                label,
                currency.format(cents / 100),
              ]),
              ["Status", stateLabels[withdrawal.state]],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-admin-body">{label}</dt>
                <dd className="m-0 text-right font-semibold text-admin-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {withdrawal.settlement && withdrawal.settlement.releasedCents > 0 && (
            <p className="m-0 text-admin-muted">
              Reserva liberada:{" "}
              {currency.format(withdrawal.settlement.releasedCents / 100)}. O
              limite aprovado foi{" "}
              {currency.format(withdrawal.amountCents / 100)}.
            </p>
          )}
          <p className="m-0 text-admin-muted">
            Solicitado em{" "}
            <time dateTime={withdrawal.createdAt}>
              {formatDate(withdrawal.createdAt)}
            </time>
            . Atualizado em{" "}
            <time dateTime={withdrawal.updatedAt}>
              {formatDate(withdrawal.updatedAt)}
            </time>
            .
          </p>
          {withdrawal.state === "COMPLETED" && (
            <p className="m-0 text-admin-muted">
              A conclusão informada pelo provedor não confirma o crédito na
              conta bancária.
            </p>
          )}
          {withdrawal.state === "UNKNOWN" && (
            <p className="m-0 text-admin-muted">
              O resultado segue em verificação e ainda não pode ser confirmado.
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

function readWithdrawals(
  siteId: string,
  access: SiteAccess | null,
  result: WithdrawalHistoryResult,
) {
  const authorized = canReadFinancialOverview(siteId, access);
  if (!authorized || result.status !== "ready")
    return { authorized, withdrawals: null, invalid: false };
  try {
    return {
      authorized,
      withdrawals: parseWithdrawalHistory(siteId, {
        withdrawals: result.withdrawals,
      }),
      invalid: false,
    };
  } catch {
    return { authorized, withdrawals: null, invalid: true };
  }
}

function HistoryMessage({
  result,
  invalid,
}: {
  result: WithdrawalHistoryResult;
  invalid: boolean;
}) {
  const className =
    "m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted";
  if (invalid || result.status === "error")
    return (
      <p role="alert" className={className}>
        Não foi possível consultar o histórico de saques.
      </p>
    );
  if (result.status === "loading")
    return (
      <p role="status" className={className}>
        Consultando o histórico de saques…
      </p>
    );
  if (result.status === "unavailable")
    return (
      <p role="status" className={className}>
        Histórico de saques indisponível. A consulta não confirmou se existem
        saques.
      </p>
    );
  return <p className={className}>Ainda não há saques registrados.</p>;
}

export function WithdrawalHistoryView({
  siteId,
  access,
  result,
  onRefresh,
  onLoadMore,
  loadingMore,
  pageError,
}: {
  siteId: string;
  access: SiteAccess | null;
  result: WithdrawalHistoryResult;
  onRefresh?: () => void;
  onLoadMore?: (cursor: string) => Promise<void>;
  loadingMore?: boolean;
  pageError?: boolean;
}) {
  const { authorized, withdrawals, invalid } = readWithdrawals(
    siteId,
    access,
    result,
  );
  return (
    <section
      aria-labelledby="withdrawal-history-title"
      className={`${readyCard} grid py-2`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-6 pt-3.5 pb-2.5 [@media(max-width:760px)]:px-5">
        <h2 id="withdrawal-history-title" className={readyCardTitle}>
          {authorized ? "Histórico de saques" : "Acesso financeiro restrito"}
        </h2>
        {authorized && onRefresh && (
          <button
            type="button"
            className={readyQuietButton}
            disabled={result.status === "loading"}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Atualizar
          </button>
        )}
      </div>
      {!authorized ? (
        <p
          role="status"
          className="m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted"
        >
          Apenas os administradores autorizados deste casamento podem consultar
          valores e movimentações.
        </p>
      ) : withdrawals && withdrawals.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {withdrawals.map((withdrawal) => (
            <WithdrawalRecord key={withdrawal.id} withdrawal={withdrawal} />
          ))}
        </ul>
      ) : (
        <HistoryMessage result={result} invalid={invalid} />
      )}
      {authorized &&
        !invalid &&
        result.status === "ready" &&
        result.nextCursor &&
        onLoadMore && (
          <div className="grid justify-items-start gap-2 px-6 pb-3">
            {pageError && (
              <p role="alert" className="m-0 text-sm text-admin-danger-ink">
                Não foi possível carregar mais saques.
              </p>
            )}
            <LoadMoreButton
              cursor={result.nextCursor}
              onLoad={onLoadMore}
              loading={loadingMore}
              manualOnly={pageError}
              label="Carregar mais saques"
            />
          </div>
        )}
    </section>
  );
}

// Overview list: the three latest withdrawals from the same history read.
export function RecentWithdrawals({
  siteId,
  access,
  result,
  viewAll,
}: {
  siteId: string;
  access: SiteAccess | null;
  result: WithdrawalHistoryResult;
  viewAll: ReactNode;
}) {
  const { authorized, withdrawals, invalid } = readWithdrawals(
    siteId,
    access,
    result,
  );
  const recent = withdrawals?.slice(0, 3) ?? [];
  return (
    <section
      aria-labelledby="recent-withdrawals-title"
      className={`${readyCard} grid content-start py-2`}
    >
      <div className="flex items-center justify-between gap-3 px-6 pt-3.5 pb-2.5">
        <h2 id="recent-withdrawals-title" className={readyCardTitle}>
          Últimos saques
        </h2>
        {authorized && recent.length > 0 && viewAll}
      </div>
      {authorized && recent.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {recent.map((withdrawal) => (
            <li
              key={withdrawal.id}
              className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-admin-beige px-6 py-3.5"
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <strong className="text-[15px] text-admin-ink">
                  {netAmount(withdrawal)}
                </strong>
                <time
                  dateTime={withdrawal.createdAt}
                  className="text-[13px] text-admin-muted"
                >
                  {formatDate(withdrawal.createdAt)}
                </time>
              </span>
              <WithdrawalStateBadge state={withdrawal.state} />
            </li>
          ))}
        </ul>
      ) : authorized ? (
        <HistoryMessage result={result} invalid={invalid} />
      ) : (
        <p
          role="status"
          className="m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted"
        >
          Acesso financeiro restrito.
        </p>
      )}
    </section>
  );
}
