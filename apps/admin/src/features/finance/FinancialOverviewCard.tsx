import {
  type FinancialOverview,
  financialOverviewSchema,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { Button, showSandboxNotice } from "@entrelacos/ui";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const money = (cents: number) => currency.format(cents / 100);

export function FinancialOverviewCard({
  siteId,
  access,
  overview,
  loading = false,
  error = false,
  onRetry,
}: {
  siteId: string;
  access: SiteAccess | null;
  overview: FinancialOverview | null;
  loading?: boolean;
  error?: boolean;
  onRetry: () => void;
}) {
  const parsedAccess = siteAccessSchema.safeParse(access);
  const authorized =
    parsedAccess.success &&
    parsedAccess.data.siteId === siteId &&
    ((parsedAccess.data.membershipRole === "SITE_ADMIN" &&
      parsedAccess.data.membershipId !== null) ||
      (parsedAccess.data.membershipRole === "OWNER" &&
        parsedAccess.data.membershipId === null &&
        !parsedAccess.data.capabilities.configureReceiving &&
        !parsedAccess.data.capabilities.requestWithdrawal)) &&
    parsedAccess.data.capabilities.readFinance;
  const parsed = financialOverviewSchema.safeParse(overview);
  const current =
    authorized &&
    !loading &&
    !error &&
    parsed.success &&
    parsed.data.siteId === siteId
      ? parsed.data
      : null;
  const title = !authorized
    ? "Acesso financeiro restrito"
    : loading
      ? "Consultando o financeiro"
      : current
        ? "Resumo financeiro"
        : "Resumo financeiro indisponível";
  return (
    <section
      aria-labelledby="financial-overview-title"
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-muted">
        Financeiro
      </p>
      <h2
        id="financial-overview-title"
        className="m-0 font-admin-display text-2xl text-admin-graphite"
      >
        {title}
      </h2>
      {!authorized ? (
        <p role="status" className="m-0 text-admin-muted">
          Apenas os administradores autorizados deste casamento podem consultar
          valores e movimentações.
        </p>
      ) : current ? (
        <>
          {showSandboxNotice(current.mode) && (
            <p className="m-0 text-sm text-admin-muted">
              Sandbox — valores de teste, sem movimentação de dinheiro real.
            </p>
          )}
          <dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Presentes recebidos", money(current.nominalReceivedCents)],
              ["Valor líquido recebido", money(current.netReceivedCents)],
              ["Custos de processamento", money(current.processingCents)],
              ["Comissão da plataforma", money(current.commissionCents)],
              ["Aguardando liberação", money(current.awaitingReleaseCents)],
              [
                "Saldo disponível",
                current.availableCents === null
                  ? "Ainda não confirmado"
                  : money(current.availableCents),
              ],
              ["Saques pendentes", money(current.pendingCommitmentsCents)],
              ["Saques concluídos", money(current.withdrawnCents)],
              ["Valores reembolsados", money(current.refundedCents)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="grid gap-1 rounded-lg border border-admin-line p-4"
              >
                <dt className="text-sm text-admin-muted">{label}</dt>
                <dd className="m-0 font-semibold text-admin-graphite">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {current.availability === "STALE" && (
            <p role="status" className="m-0 text-admin-muted">
              Saldo desatualizado. Aguarde uma nova confirmação para solicitar
              uma transferência.
            </p>
          )}
          {current.synchronizedAt && (
            <p className="m-0 text-sm text-admin-muted">
              Última atualização:{" "}
              <time dateTime={current.synchronizedAt}>
                {new Date(current.synchronizedAt).toLocaleString("pt-BR", {
                  timeZone: "America/Sao_Paulo",
                })}
              </time>
              .
            </p>
          )}
          <p className="m-0 text-sm text-admin-muted">
            Os valores recebidos e os valores disponíveis para saque podem ser
            diferentes. O saldo disponível depende da confirmação do provedor.
          </p>
        </>
      ) : (
        <>
          <p role={error ? "alert" : "status"} className="m-0 text-admin-muted">
            {loading
              ? "Aguarde enquanto consultamos os valores deste casamento."
              : "Não há um saldo confirmado para exibir. Os recebimentos e as movimentações dependem da habilitação e da confirmação do provedor."}
          </p>
          {error && (
            <div>
              <Button type="button" variant="outline" onClick={onRetry}>
                Tentar novamente
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
