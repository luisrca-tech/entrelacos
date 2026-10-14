import { Button } from "@entrelacos/ui";
import { useLayoutEffect, useReducer, useRef } from "react";
import {
  createGiftPaymentHistoryController,
  createGiftPaymentHistorySession,
  type GiftPaymentHistoryState,
  type HistoryPorts,
  type HistoryViewerScope,
} from "./giftPaymentHistory";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const date = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});
const labels = {
  UNKNOWN: "Não confirmado",
  PENDING: "Pendente na observação",
  CONFIRMED: "Confirmado na observação",
  RECEIVED: "Recebido na observação",
  RESTRICTED: "Restrito na observação",
};
function amount(value: number | null) {
  return value === null ? "Não registrado" : money.format(value / 100);
}
function instant(micros: string | null) {
  if (micros === null) return "Não registrado";
  const value = new Date(Number(BigInt(micros) / 1000n));
  return date.format(value);
}
function Values({ values }: { values: Array<[string, string]> }) {
  return (
    <dl className="m-0 grid gap-3 sm:grid-cols-2">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt className="text-sm text-admin-muted">{label}</dt>
          <dd className="m-0 font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
const masked: GiftPaymentHistoryState = {
  status: "denied",
  busy: false,
  admissions: 0,
  purchases: [],
  nextIndexCursor: null,
  nextDetailCursor: null,
  indexReadCount: null,
  detail: null,
};

export function GiftPaymentHistoryView(
  props: HistoryViewerScope & { ports?: HistoryPorts },
) {
  const session = useRef<ReturnType<
    typeof createGiftPaymentHistorySession
  > | null>(null);
  if (!session.current) session.current = createGiftPaymentHistorySession();
  const stableSession = session.current;
  const defaults = useRef<HistoryPorts>({});
  const ports = props.ports ?? defaults.current;
  const controller = useRef<ReturnType<
    typeof createGiftPaymentHistoryController
  > | null>(null);
  const [, redraw] = useReducer((value) => value + 1, 0);
  const native = stableSession.inspect(props, ports);
  let owner: HistoryPorts["owner"],
    request: HistoryPorts["request"],
    clock: HistoryPorts["now"];
  try {
    owner = ports.owner;
    request = ports.request;
    clock = ports.now;
  } catch {}
  // biome-ignore lint/correctness/useExhaustiveDependencies: Mutable port identities and native snapshots fence same-object replacements.
  useLayoutEffect(() => {
    const detach = stableSession.attach();
    const next = createGiftPaymentHistoryController(
      {
        siteId: props.siteId,
        access: props.access,
        sessionEpoch: props.sessionEpoch,
      },
      () => redraw(),
      ports,
      stableSession,
    );
    controller.current = next;
    redraw();
    // A discarded StrictMode setup must not dispatch the initial read.
    void Promise.resolve().then(() => next.loadFirstIndex());
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
      detach();
    };
  }, [
    props.siteId,
    props.access,
    props.sessionEpoch,
    ports,
    owner,
    request,
    clock,
    native?.snapshot,
    stableSession,
  ]);
  const bound = controller.current?.isBoundTo(props, ports);
  const active = bound ? controller.current : null;
  const state = active?.getState() ?? {
    ...masked,
    status: native ? "unavailable" : "denied",
  };
  const allowed = state.status !== "denied";
  const limited = state.admissions >= 64;
  const disabled = !active || state.busy || limited;
  const detail = state.detail;
  return (
    <section
      aria-labelledby="gift-payment-history-title"
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
    >
      <h2
        id="gift-payment-history-title"
        className="m-0 font-admin-display text-2xl text-admin-graphite"
      >
        {allowed ? "Histórico de presentes" : "Acesso financeiro restrito"}
      </h2>
      {!allowed ? (
        <p role="status">
          Apenas administradores com sessão e acesso financeiro verificados
          podem consultar este histórico.
        </p>
      ) : (
        <>
          <p>
            Situação financeira atual não confirmada. Consultas separadas não
            comprovam saldo, estornos ou crédito bancário.
          </p>
          <p role="status">
            {state.status === "loading"
              ? "Consultando o histórico de presentes…"
              : state.status === "local_limit" || limited
                ? "Limite local de consultas atingido. O histórico retido permanece disponível."
                : state.status === "local_code"
                  ? "Esta identidade exige compatibilidade de consulta ainda indisponível."
                  : state.status === "conflict"
                    ? "A consulta apresentou informações conflitantes. O histórico anterior foi preservado."
                    : state.status === "unavailable"
                      ? "Histórico de presentes indisponível nesta consulta. O histórico anterior foi preservado."
                      : "Cada consulta representa uma observação independente."}
          </p>
          <p className="text-sm text-admin-muted">
            Consultas deste contexto: {state.admissions} de 64.
          </p>
          {state.status === "ready" && state.indexReadCount === 0 && (
            <p>
              Esta consulta não retornou compras. Isso não confirma histórico
              completo.
            </p>
          )}
          <ul className="m-0 grid min-w-0 list-none gap-3 p-0">
            {state.purchases.map((purchase) => (
              <li
                key={purchase.orderId}
                className="grid min-w-0 gap-2 rounded-lg border border-admin-line p-4"
              >
                <h3 className="m-0">{purchase.titleSnapshot}</h3>
                {purchase.mode === "sandbox" && (
                  <p>
                    Sandbox — valores de teste, sem movimentação de dinheiro
                    real.
                  </p>
                )}
                <p>
                  Compra original em {instant(purchase.purchasedAtMicros)} ·{" "}
                  {purchase.method === "PIX" ? "Pix" : "Cartão"}
                </p>
                <p>
                  Valor original da cotação:{" "}
                  {amount(purchase.quoted.totalCents)}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void active?.openPurchase(purchase.orderId);
                  }}
                >
                  Ver histórico desta compra
                </Button>
              </li>
            ))}
          </ul>
          {state.nextIndexCursor && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                void active?.loadMoreIndex(state.nextIndexCursor as string);
              }}
            >
              Carregar mais compras
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              void active?.restartIndex();
            }}
          >
            Reiniciar navegação das compras
          </Button>
          {(state.status === "unavailable" || state.status === "conflict") && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                void active?.retryFailedRead();
              }}
            >
              Tentar consulta novamente
            </Button>
          )}
          {detail && (
            <div className="grid min-w-0 gap-4 border-t border-admin-line pt-4">
              <h3 className="m-0">{detail.purchase.titleSnapshot}</h3>
              <h4 className="m-0">Valores da cotação</h4>
              <Values
                values={[
                  [
                    "Valor do presente",
                    amount(detail.purchase.quoted.nominalCents),
                  ],
                  [
                    "Comissão original",
                    amount(detail.purchase.quoted.commissionCents),
                  ],
                  [
                    "Processamento original",
                    amount(detail.purchase.quoted.processingCents),
                  ],
                  ["Total original", amount(detail.purchase.quoted.totalCents)],
                ]}
              />
              <h4 className="m-0">Observação retida nesta consulta</h4>
              <p>
                Cobertura de pagamentos nesta leitura:{" "}
                {detail.coverage.payments === "AVAILABLE"
                  ? "Disponível"
                  : "Indisponível"}
                . Observações anteriores permanecem históricas e incomparáveis.
              </p>
              {detail.samples.map((sample) => (
                <div key={JSON.stringify(sample)} className="grid gap-2">
                  <p>
                    {labels[sample.recordedState]} · observação em{" "}
                    {instant(sample.observedAtMicros)}
                  </p>
                  <Values
                    values={[
                      ["Valor bruto observado", amount(sample.grossCents)],
                      [
                        "Processamento observado",
                        amount(sample.processingCents),
                      ],
                      ["Comissão observada", amount(sample.commissionCents)],
                      ["Líquido observado", amount(sample.recipientNetCents)],
                    ]}
                  />
                </div>
              ))}
              {detail.samples.length === 0 && (
                <p>
                  Nenhuma observação de pagamento retida. Isso não confirma
                  ausência de pagamento.
                </p>
              )}
              <h4 className="m-0">Recebimento histórico registrado no razão</h4>
              <p>
                Cobertura de recibos nesta leitura:{" "}
                {detail.coverage.receipts === "AVAILABLE"
                  ? "Disponível"
                  : "Indisponível"}
                . Registros anteriores são histórico retido.
              </p>
              {detail.receipts.map((receipt) => (
                <p key={receipt.effectId}>
                  Crédito histórico: {amount(receipt.recipientCreditCents)},
                  registrado em {instant(receipt.postedAtMicros)}. Não confirma
                  situação atual nem crédito bancário.
                </p>
              ))}
              {detail.receipts.length === 0 && (
                <p>
                  Nenhum recebimento histórico retido. Isso não confirma
                  ausência de recebimento.
                </p>
              )}
              <p>
                Estornos e liquidação bancária indisponíveis nesta consulta.
              </p>
              {detail.purchase.binding === "UNBOUND" && (
                <p>
                  Vínculo original indisponível; os fatos financeiros desta
                  compra não puderam ser consultados.
                </p>
              )}
              {state.nextDetailCursor && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void active?.loadMoreDetail(
                      detail.purchase.orderId,
                      state.nextDetailCursor as string,
                    );
                  }}
                >
                  Carregar mais fatos desta compra
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  void active?.restartDetail(detail.purchase.orderId);
                }}
              >
                Reiniciar navegação do detalhe
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={() => active?.closeDetail()}
              >
                Fechar detalhe
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
