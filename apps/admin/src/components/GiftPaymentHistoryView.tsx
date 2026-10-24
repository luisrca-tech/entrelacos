import {
  Badge,
  Button,
  Input,
  showSandboxNotice,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@entrelacos/ui";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  createGiftPaymentHistoryController,
  createGiftPaymentHistorySession,
  type GiftPaymentHistoryState,
  type HistoryPorts,
  type HistoryViewerScope,
} from "./giftPaymentHistory";

import {
  filterLoadedGiftPurchases,
  type GiftPurchaseMethodFilter,
} from "./giftPurchaseFilters";

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
  const filterId = useId();
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState<GiftPurchaseMethodFilter>("ALL");
  const purchases = filterLoadedGiftPurchases(state.purchases, search, method);
  useEffect(() => {
    if (!bound) return;
    if (state.status === "unavailable")
      toast.error("Não foi possível consultar os pagamentos. Tente novamente.");
    else if (state.status === "conflict")
      toast.warning(
        "A consulta retornou informações conflitantes. O histórico anterior foi preservado.",
      );
  }, [bound, state.status]);
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
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
            <div className="grid gap-1.5">
              <label
                className="text-sm font-medium"
                htmlFor={`${filterId}-search`}
              >
                Buscar presente
              </label>
              <Input
                id={`${filterId}-search`}
                type="search"
                placeholder="Nome do presente"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <label
                className="text-sm font-medium"
                htmlFor={`${filterId}-method`}
              >
                Forma de pagamento
              </label>
              <select
                id={`${filterId}-method`}
                value={method}
                onChange={(event) =>
                  setMethod(event.target.value as GiftPurchaseMethodFilter)
                }
                className="h-11 rounded-lg border border-admin-line bg-admin-surface px-3 text-sm"
              >
                <option value="ALL">Todas</option>
                <option value="PIX">Pix</option>
                <option value="CREDIT_CARD">Cartão</option>
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void active?.restartIndex()}
            >
              Consultar compras
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-admin-muted">
            <span>
              {purchases.length} de {state.purchases.length} compras carregadas
            </span>
            <Badge variant="outline">Histórico por consulta</Badge>
          </div>
          {state.status === "loading" && (
            <p role="status" className="text-sm text-admin-muted">
              Consultando o histórico de presentes…
            </p>
          )}
          {(state.status === "local_limit" || limited) && (
            <p role="status" className="text-sm text-admin-muted">
              Limite local de consultas atingido. O histórico retido permanece
              disponível.
            </p>
          )}
          {(state.status === "unavailable" || state.status === "conflict") && (
            <p role="status" className="text-sm text-admin-muted">
              {state.status === "unavailable"
                ? "Histórico de presentes indisponível nesta consulta. O histórico anterior foi preservado."
                : "A consulta apresentou informações conflitantes. O histórico anterior foi preservado."}
            </p>
          )}
          {state.status === "local_code" && (
            <p role="status" className="text-sm text-admin-muted">
              Esta identidade exige compatibilidade de consulta ainda
              indisponível.
            </p>
          )}
          <details className="rounded-lg border border-admin-line px-4 py-3 text-sm text-admin-muted">
            <summary className="cursor-pointer font-medium">
              Sobre os dados deste histórico
            </summary>
            <p className="mt-3">
              Situação financeira atual não confirmada. Consultas separadas não
              comprovam saldo, estornos ou crédito bancário. Os filtros
              consideram somente as compras carregadas nesta consulta.
            </p>
            <p className="mt-2">
              Consultas deste contexto: {state.admissions} de 64.
            </p>
          </details>
          {state.status === "ready" && state.indexReadCount === 0 && (
            <p>
              Esta consulta não retornou compras. Isso não confirma histórico
              completo.
            </p>
          )}
          {purchases.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Presente</TableHead>
                  <TableHead>Pagamento</TableHead>
                  <TableHead>Compra</TableHead>
                  <TableHead className="text-right">Valor da cotação</TableHead>
                  <TableHead>
                    <span className="sr-only">Ações</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((purchase) => (
                  <TableRow key={purchase.orderId}>
                    <TableCell className="font-medium">
                      <span>{purchase.titleSnapshot}</span>
                      {showSandboxNotice(purchase.mode) && (
                        <Badge variant="outline" className="ml-2">
                          Sandbox
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {purchase.method === "PIX" ? "Pix" : "Cartão"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {instant(purchase.purchasedAtMicros)}
                    </TableCell>
                    <TableCell className="text-right">
                      {amount(purchase.quoted.totalCents)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          void active?.openPurchase(purchase.orderId)
                        }
                      >
                        Ver histórico desta compra
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            state.purchases.length > 0 && (
              <p className="py-6 text-center text-sm text-admin-muted">
                Nenhuma compra carregada corresponde aos filtros.
              </p>
            )
          )}
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
                Consultar histórico novamente
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
