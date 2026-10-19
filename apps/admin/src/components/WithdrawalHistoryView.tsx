import type { SiteAccess, WithdrawalIntent } from "@entrelacos/contracts";
import { Button, showSandboxNotice } from "@entrelacos/ui";
import { canReadFinancialOverview } from "./financialOverview";
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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Data indisponível"
    : dateFormatter.format(date);
}

function WithdrawalRecord({ withdrawal }: { withdrawal: WithdrawalIntent }) {
  return (
    <li className="grid min-w-0 gap-3 rounded-lg border border-admin-line p-4">
      {showSandboxNotice(withdrawal.mode) && (
        <p className="m-0 text-sm text-admin-muted">
          Sandbox — valores de teste, sem movimentação de dinheiro real.
        </p>
      )}
      <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            withdrawal.settlement
              ? "Valor debitado"
              : withdrawal.feeSemantics === "MAXIMUM"
                ? "Débito máximo aprovado"
                : "Valor solicitado",
            currency.format(
              (withdrawal.settlement?.totalDebitCents ??
                withdrawal.amountCents) / 100,
            ),
          ],
          [
            withdrawal.settlement
              ? "Taxa efetiva"
              : withdrawal.feeSemantics === "MAXIMUM"
                ? "Taxa máxima"
                : "Taxa",
            currency.format(
              (withdrawal.settlement?.feeCents ?? withdrawal.feeCents) / 100,
            ),
          ],
          ["Valor líquido", currency.format(withdrawal.netCents / 100)],
          ["Status", stateLabels[withdrawal.state]],
        ].map(([label, value]) => (
          <div key={label} className="grid gap-1">
            <dt className="text-sm text-admin-muted">{label}</dt>
            <dd className="m-0 font-semibold text-admin-graphite">{value}</dd>
          </div>
        ))}
      </dl>
      {withdrawal.settlement && (
        <p className="m-0 text-sm text-admin-muted">
          Reserva liberada:{" "}
          {currency.format(withdrawal.settlement.releasedCents / 100)}. O limite
          aprovado foi {currency.format(withdrawal.amountCents / 100)}.
        </p>
      )}
      <p className="m-0 text-sm text-admin-muted">
        Solicitado em{" "}
        <time dateTime={withdrawal.createdAt}>
          {formatDate(withdrawal.createdAt)}
        </time>
        .
      </p>
      <p className="m-0 text-sm text-admin-muted">
        Atualizado em{" "}
        <time dateTime={withdrawal.updatedAt}>
          {formatDate(withdrawal.updatedAt)}
        </time>
        .
      </p>
      {withdrawal.state === "COMPLETED" && (
        <p className="m-0 text-sm text-admin-muted">
          A conclusão informada pelo provedor não confirma o crédito na conta
          bancária.
        </p>
      )}
      {withdrawal.state === "UNKNOWN" && (
        <p className="m-0 text-sm text-admin-muted">
          O resultado segue em verificação e ainda não pode ser confirmado.
        </p>
      )}
    </li>
  );
}

export function WithdrawalHistoryView({
  siteId,
  access,
  result,
  onRefresh,
}: {
  siteId: string;
  access: SiteAccess | null;
  result: WithdrawalHistoryResult;
  onRefresh?: () => void;
}) {
  const authorized = canReadFinancialOverview(siteId, access);
  let withdrawals: WithdrawalIntent[] | null = null;
  let invalidResult = false;

  if (authorized && result.status === "ready") {
    try {
      withdrawals = parseWithdrawalHistory(siteId, {
        withdrawals: result.withdrawals,
      });
    } catch {
      invalidResult = true;
    }
  }

  return (
    <section
      aria-labelledby="withdrawal-history-title"
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-muted">
        Financeiro
      </p>
      <h2
        id="withdrawal-history-title"
        className="m-0 font-admin-display text-2xl text-admin-graphite"
      >
        {authorized ? "Histórico de saques" : "Acesso financeiro restrito"}
      </h2>
      {!authorized ? (
        <p role="status" className="m-0 text-admin-muted">
          Apenas os administradores autorizados deste casamento podem consultar
          valores e movimentações.
        </p>
      ) : invalidResult || result.status === "error" ? (
        <p role="alert" className="m-0 text-admin-muted">
          Não foi possível consultar o histórico de saques.
        </p>
      ) : result.status === "loading" ? (
        <p role="status" className="m-0 text-admin-muted">
          Consultando o histórico de saques…
        </p>
      ) : result.status === "unavailable" ? (
        <p role="status" className="m-0 text-admin-muted">
          Histórico de saques indisponível. A consulta não confirmou se existem
          saques.
        </p>
      ) : withdrawals?.length === 0 ? (
        <p className="m-0 text-admin-muted">Ainda não há saques registrados.</p>
      ) : (
        <ul className="m-0 grid min-w-0 list-none gap-3 p-0">
          {withdrawals?.map((withdrawal) => (
            <WithdrawalRecord key={withdrawal.id} withdrawal={withdrawal} />
          ))}
        </ul>
      )}
      {authorized && onRefresh && (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={result.status === "loading"}
            onClick={onRefresh}
          >
            Consultar novamente
          </Button>
        </div>
      )}
    </section>
  );
}
