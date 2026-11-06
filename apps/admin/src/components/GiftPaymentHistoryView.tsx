import type {
  FinancialOverview,
  GiftPurchaseHistoryPayment,
} from "@entrelacos/contracts";
import { Badge, Button, showSandboxNotice, toast } from "@entrelacos/ui";
import { Gift, Search } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { AdminSidePanel } from "./AdminSidePanel";
import { financialFlow, formatCents, purchaseNetCents } from "./financialFlow";
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
import {
  readyCard,
  readyLinkButton,
  readyQuietButton,
  receivingField,
} from "./receivingUi";

const date = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});
const shortDate = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});
const sampleLabels: Record<
  GiftPurchaseHistoryPayment["recordedState"],
  string
> = {
  UNKNOWN: "Situação do pagamento não confirmada",
  PENDING: "Aguardando o pagamento",
  CONFIRMED: "Pagamento confirmado, aguardando liberação",
  RECEIVED: "Pagamento recebido",
  RESTRICTED: "Pagamento com restrição no Asaas",
};
const sampleDots: Record<GiftPurchaseHistoryPayment["recordedState"], string> =
  {
    UNKNOWN: "bg-admin-line-strong",
    PENDING: "bg-admin-line-strong",
    CONFIRMED: "bg-admin-awaiting",
    RECEIVED: "bg-admin-status-confirmed",
    RESTRICTED: "bg-admin-status-declined",
  };
function amount(value: number | null) {
  return value === null ? "Não registrado" : formatCents(value);
}
function micros(value: string) {
  return new Date(Number(BigInt(value) / 1000n));
}
export function instant(value: string | null, format = date) {
  return value === null ? "Data não registrada" : format.format(micros(value));
}
export function methodLabel(method: "PIX" | "CREDIT_CARD") {
  return method === "PIX" ? "Pix" : "Cartão";
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

// Owns one purchase-history controller; every read keeps the existing guards.
export function useGiftPaymentHistory(
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
  const bound = !!controller.current?.isBoundTo(props, ports);
  const active = bound ? controller.current : null;
  const state = active?.getState() ?? {
    ...masked,
    status: native ? "unavailable" : "denied",
  };
  const limited = state.admissions >= 64;
  return {
    bound,
    active,
    state,
    allowed: state.status !== "denied",
    limited,
    disabled: !active || state.busy || limited,
  };
}

export type PaymentTotals = {
  overview: FinancialOverview | null;
  loading: boolean;
};

function Totals({
  count,
  more,
  totals,
}: {
  count: number;
  more: boolean;
  totals?: PaymentTotals;
}) {
  const flow = totals?.overview ? financialFlow(totals.overview) : null;
  const pending = totals?.loading ? "Consultando…" : "Indisponível";
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
      {[
        {
          label: "Compras registradas",
          value: `${count}${more ? "+" : ""}`,
          hint: null,
          tone: "text-admin-ink",
        },
        {
          label: "Pago pelos convidados",
          value: flow ? formatCents(flow.releasedGrossCents) : pending,
          hint: flow ? "em presentes já liberados" : null,
          tone: flow ? "text-admin-ink" : "text-xl text-admin-muted",
        },
        {
          label: "Para vocês, depois das taxas",
          value: flow ? formatCents(flow.netForCoupleCents) : pending,
          hint: flow ? "inclui o que aguarda liberação" : null,
          tone: flow ? "text-admin-success-ink" : "text-xl text-admin-muted",
        },
      ].map((item) => (
        <div
          key={item.label}
          className="grid min-w-0 content-start gap-0.5 rounded-[14px] border border-admin-line bg-admin-surface px-[18px] py-4"
        >
          <dt className="text-[13px] text-admin-muted">{item.label}</dt>
          <dd
            className={`m-0 font-admin-display text-[28px] leading-[1.2] ${item.tone}`}
          >
            {item.value}
          </dd>
          {item.hint && (
            <dd className="m-0 text-xs text-admin-muted">{item.hint}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

const methods: [GiftPurchaseMethodFilter, string][] = [
  ["ALL", "Todos"],
  ["PIX", "Pix"],
  ["CREDIT_CARD", "Cartão"],
];

export function GiftPaymentHistoryView(
  props: HistoryViewerScope & { ports?: HistoryPorts; totals?: PaymentTotals },
) {
  const { bound, active, state, allowed, limited, disabled } =
    useGiftPaymentHistory(props);
  const detail = state.detail;
  const filterId = useId();
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState<GiftPurchaseMethodFilter>("ALL");
  const purchases = filterLoadedGiftPurchases(state.purchases, search, method);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!bound) return;
    if (state.status === "unavailable")
      toast.error("Não foi possível consultar os pagamentos. Tente novamente.");
    else if (state.status === "conflict")
      toast.warning(
        "A consulta retornou informações conflitantes. O histórico anterior foi preservado.",
      );
  }, [bound, state.status]);
  // Moves focus to the details panel the person asked to open.
  useEffect(() => {
    const id = detail?.purchase.orderId ?? null;
    if (id && opened.current === id) detailHeading.current?.focus();
    opened.current = null;
  }, [detail?.purchase.orderId]);
  if (!allowed)
    return (
      <section
        aria-labelledby="gift-payment-history-title"
        className={`${readyCard} grid gap-3 p-6`}
      >
        <h2
          id="gift-payment-history-title"
          className="m-0 text-[17px] font-bold text-admin-ink"
        >
          Acesso financeiro restrito
        </h2>
        <p role="status" className="m-0 text-admin-body">
          Apenas administradores com sessão e acesso financeiro verificados
          podem consultar este histórico.
        </p>
      </section>
    );
  return (
    <section
      aria-labelledby="gift-payment-history-title"
      className="grid min-w-0 gap-[22px]"
    >
      <h2 id="gift-payment-history-title" className="sr-only">
        Histórico de presentes
      </h2>
      <Totals
        count={state.purchases.length}
        more={!!state.nextIndexCursor}
        totals={props.totals}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <label
          htmlFor={`${filterId}-search`}
          className="relative block min-w-0 flex-[1_1_16rem] sm:max-w-[400px]"
        >
          <span className="sr-only">Buscar presente</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-admin-muted"
          />
          <input
            id={`${filterId}-search`}
            type="search"
            placeholder="Buscar presente"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${receivingField} min-h-11 pl-10`}
          />
        </label>
        <fieldset className="m-0 flex min-w-0 gap-1 rounded-xl border border-admin-line bg-admin-surface p-1">
          <legend className="sr-only">Forma de pagamento</legend>
          {methods.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={method === value}
              onClick={() => setMethod(value)}
              className={`min-h-9 rounded-[9px] px-3.5 text-sm font-semibold transition-colors motion-reduce:transition-none ${method === value ? "bg-admin-graphite text-white" : "text-admin-muted hover:bg-admin-canvas hover:text-admin-graphite"}`}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className={`${readyQuietButton} ml-auto`}
          disabled={disabled}
          onClick={() => void active?.restartIndex()}
        >
          Atualizar lista
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {purchases.length} de {state.purchases.length} compras carregadas
      </p>
      {state.status === "loading" && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          Consultando o histórico de presentes…
        </p>
      )}
      {(state.status === "local_limit" || limited) && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          Limite local de consultas atingido. O histórico retido permanece
          disponível.
        </p>
      )}
      {(state.status === "unavailable" || state.status === "conflict") && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          {state.status === "unavailable"
            ? "Histórico de presentes indisponível nesta consulta. O histórico anterior foi preservado."
            : "A consulta apresentou informações conflitantes. O histórico anterior foi preservado."}
        </p>
      )}
      {state.status === "local_code" && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          Esta identidade exige compatibilidade de consulta ainda indisponível.
        </p>
      )}
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div
          className={`${readyCard} grid min-w-0 overflow-hidden ${detail ? "" : "lg:col-span-2"}`}
        >
          {state.status === "ready" && state.indexReadCount === 0 && (
            <p className="m-0 px-5 py-6 text-sm text-admin-body">
              Esta consulta não retornou compras. Isso não confirma histórico
              completo.
            </p>
          )}
          {purchases.length > 0 ? (
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="text-[13px] text-admin-muted">
                  <th scope="col" className="px-5 py-3.5 font-semibold">
                    Presente
                  </th>
                  <th
                    scope="col"
                    className="hidden w-[136px] px-2 py-3.5 font-semibold md:table-cell"
                  >
                    Data
                  </th>
                  <th
                    scope="col"
                    className="hidden w-[128px] px-2 py-3.5 text-right font-semibold whitespace-nowrap sm:table-cell"
                  >
                    Convidado pagou
                  </th>
                  <th
                    scope="col"
                    className="w-[104px] px-5 py-3.5 text-right font-semibold whitespace-nowrap"
                  >
                    Para vocês
                  </th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => {
                  const selected =
                    detail?.purchase.orderId === purchase.orderId;
                  return (
                    <tr
                      key={purchase.orderId}
                      data-selected={selected}
                      className={`relative border-t border-admin-beige ${selected ? "bg-admin-terracotta-wash" : "hover:bg-admin-canvas"}`}
                    >
                      <td className="px-5 py-3.5 align-middle">
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`Ver detalhes de ${purchase.titleSnapshot}`}
                          aria-expanded={selected}
                          onClick={() => {
                            opened.current = purchase.orderId;
                            void active?.openPurchase(purchase.orderId);
                          }}
                          className="grid w-full min-w-0 cursor-pointer gap-1 bg-transparent p-0 text-left text-admin-ink after:absolute after:inset-0 disabled:cursor-not-allowed"
                        >
                          <span className="text-[15px] font-bold [overflow-wrap:anywhere]">
                            {purchase.titleSnapshot}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-admin-muted">
                            <span className="rounded-full bg-admin-beige px-2.5 py-1 font-bold text-admin-body">
                              {methodLabel(purchase.method)}
                            </span>
                            {showSandboxNotice(purchase.mode) && (
                              <Badge variant="outline">Sandbox</Badge>
                            )}
                            <span className="md:hidden">
                              {instant(purchase.purchasedAtMicros)}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="hidden px-2 py-3.5 whitespace-nowrap text-admin-body md:table-cell">
                        {instant(purchase.purchasedAtMicros)}
                      </td>
                      <td className="hidden px-2 py-3.5 text-right whitespace-nowrap text-admin-body sm:table-cell">
                        {formatCents(purchase.quoted.totalCents)}
                      </td>
                      <td className="px-5 py-3.5 text-right font-bold whitespace-nowrap text-admin-ink">
                        {formatCents(purchaseNetCents(purchase.quoted))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            state.purchases.length > 0 && (
              <p className="m-0 px-5 py-6 text-center text-sm text-admin-muted">
                Nenhuma compra carregada corresponde aos filtros.
              </p>
            )
          )}
          {state.purchases.length > 0 && (
            <p className="m-0 border-t border-admin-beige px-5 py-3 text-[12.5px] leading-[1.5] text-admin-muted">
              Clique em um presente para ver as taxas e o histórico. Valores
              conforme a cotação do momento da compra.
            </p>
          )}
          {(state.nextIndexCursor ||
            state.status === "unavailable" ||
            state.status === "conflict") && (
            <div className="flex flex-wrap gap-3 border-t border-admin-beige px-5 py-3">
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
              {(state.status === "unavailable" ||
                state.status === "conflict") && (
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
            </div>
          )}
        </div>
        {detail && (
          <AdminSidePanel aria-labelledby="gift-payment-detail-title">
            <div className="grid min-w-0 gap-1">
              <p className="m-0 text-xs font-bold tracking-[0.06em] text-admin-muted uppercase">
                Detalhes do presente
              </p>
              <h3
                id="gift-payment-detail-title"
                ref={detailHeading}
                tabIndex={-1}
                className="m-0 font-admin-display text-[22px] leading-[1.25] font-normal text-admin-ink outline-none [overflow-wrap:anywhere]"
              >
                {detail.purchase.titleSnapshot}
              </h3>
              <p className="m-0 text-[13px] text-admin-muted">
                {methodLabel(detail.purchase.method)} ·{" "}
                {instant(detail.purchase.purchasedAtMicros)}
              </p>
            </div>
            <dl className="m-0 grid gap-2 rounded-xl bg-admin-canvas px-4 py-3.5 text-sm">
              {[
                [
                  "Convidado pagou",
                  formatCents(detail.purchase.quoted.totalCents),
                ],
                [
                  "Comissão",
                  `− ${formatCents(detail.purchase.quoted.commissionCents)}`,
                ],
                [
                  "Processamento Asaas",
                  `− ${formatCents(detail.purchase.quoted.processingCents)}`,
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-admin-body">{label}</dt>
                  <dd className="m-0 whitespace-nowrap text-admin-ink">
                    {value}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-admin-line pt-2 font-bold">
                <dt className="text-admin-ink">Para vocês</dt>
                <dd className="m-0 whitespace-nowrap text-admin-success-ink">
                  {formatCents(purchaseNetCents(detail.purchase.quoted))}
                </dd>
              </div>
            </dl>
            <div className="grid gap-3">
              <h4 className="m-0 text-sm font-bold text-admin-ink">
                Histórico
              </h4>
              <ol className="m-0 grid list-none gap-3 p-0">
                <li className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-1 size-3 shrink-0 rounded-full bg-admin-graphite"
                  />
                  <div className="grid min-w-0 gap-0.5">
                    <strong className="text-sm text-admin-ink">
                      Compra registrada
                    </strong>
                    <span className="text-[13px] text-admin-muted">
                      {instant(detail.purchase.purchasedAtMicros)}
                    </span>
                  </div>
                </li>
                {detail.samples.map((sample) => (
                  <li
                    key={JSON.stringify(sample)}
                    className="flex items-start gap-3"
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1 size-3 shrink-0 rounded-full ${sampleDots[sample.recordedState]}`}
                    />
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="text-sm text-admin-ink">
                        {sampleLabels[sample.recordedState]}
                      </strong>
                      <span className="text-[13px] text-admin-muted">
                        {instant(sample.observedAtMicros)}
                        {sample.recipientNetCents !== null &&
                          ` · ${amount(sample.recipientNetCents)} para vocês`}
                      </span>
                    </div>
                  </li>
                ))}
                {detail.receipts.map((receipt) => (
                  <li key={receipt.effectId} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1 size-3 shrink-0 rounded-full bg-admin-status-confirmed"
                    />
                    <div className="grid min-w-0 gap-0.5">
                      <strong className="text-sm text-admin-ink">
                        Crédito registrado para vocês:{" "}
                        {amount(receipt.recipientCreditCents)}
                      </strong>
                      <span className="text-[13px] text-admin-muted">
                        {instant(receipt.postedAtMicros)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
              {detail.samples.length === 0 && (
                <p className="m-0 text-[13px] text-admin-muted">
                  Nenhuma observação de pagamento nesta consulta. Isso não
                  confirma ausência de pagamento.
                </p>
              )}
              <p className="m-0 text-[12.5px] leading-[1.5] text-admin-muted">
                Pagamentos{" "}
                {detail.coverage.payments === "AVAILABLE"
                  ? "consultados"
                  : "indisponíveis"}{" "}
                e créditos{" "}
                {detail.coverage.receipts === "AVAILABLE"
                  ? "consultados"
                  : "indisponíveis"}{" "}
                nesta leitura. Estornos e liquidação bancária não aparecem aqui;
                o histórico não confirma a situação atual nem o crédito no
                banco.
              </p>
              {detail.purchase.binding === "UNBOUND" && (
                <p className="m-0 text-[13px] text-admin-muted">
                  Vínculo original indisponível; os fatos financeiros desta
                  compra não puderam ser consultados.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4">
              {state.nextDetailCursor && (
                <button
                  type="button"
                  className={readyLinkButton}
                  disabled={disabled}
                  onClick={() => {
                    void active?.loadMoreDetail(
                      detail.purchase.orderId,
                      state.nextDetailCursor as string,
                    );
                  }}
                >
                  Carregar mais fatos desta compra
                </button>
              )}
              <button
                type="button"
                className={readyLinkButton}
                disabled={disabled}
                onClick={() => {
                  void active?.restartDetail(detail.purchase.orderId);
                }}
              >
                Consultar histórico novamente
              </button>
              <button
                type="button"
                className={readyLinkButton}
                disabled={state.busy}
                onClick={() => active?.closeDetail()}
              >
                Fechar detalhe
              </button>
            </div>
          </AdminSidePanel>
        )}
      </div>
      <details className="text-[13px] text-admin-muted">
        <summary className="w-fit cursor-pointer font-semibold">
          Sobre os dados deste histórico
        </summary>
        <p className="mt-2 mb-0 max-w-3xl leading-[1.55]">
          Situação financeira atual não confirmada. Consultas separadas não
          comprovam saldo, estornos ou crédito bancário. A busca e os filtros
          consideram somente as compras carregadas nesta consulta.
        </p>
        <p className="mt-2 mb-0">
          Consultas deste contexto: {state.admissions} de 64.
        </p>
      </details>
    </section>
  );
}

// Compact list for the overview: the latest loaded purchases, no extra reads.
export function RecentGiftPurchases({
  history,
  viewAll,
}: {
  history: ReturnType<typeof useGiftPaymentHistory>;
  viewAll: ReactNode;
}) {
  const { state, allowed } = history;
  const recent = state.purchases.slice(0, 3);
  return (
    <section
      aria-labelledby="recent-gifts-title"
      className={`${readyCard} grid content-start py-2`}
    >
      <div className="flex items-center justify-between gap-3 px-6 pt-3.5 pb-2.5">
        <h2
          id="recent-gifts-title"
          className="m-0 text-[17px] font-bold text-admin-ink"
        >
          Últimos presentes
        </h2>
        {allowed && recent.length > 0 && viewAll}
      </div>
      {!allowed ? (
        <p
          role="status"
          className="m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted"
        >
          Acesso financeiro restrito.
        </p>
      ) : recent.length === 0 ? (
        <p
          role="status"
          className="m-0 border-t border-admin-beige px-6 py-4 text-sm text-admin-muted"
        >
          {state.status === "loading" || state.status === "idle"
            ? "Consultando os presentes…"
            : state.status === "ready"
              ? "Nenhuma compra registrada ainda."
              : "Não foi possível consultar os presentes agora."}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {recent.map((purchase) => (
            <li
              key={purchase.orderId}
              className="flex min-w-0 items-center gap-3.5 border-t border-admin-beige px-6 py-3.5 [@media(max-width:760px)]:px-5"
            >
              <span
                aria-hidden="true"
                className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-admin-terracotta-wash text-admin-terracotta-deep [@media(max-width:420px)]:hidden"
              >
                <Gift className="size-5" />
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <strong className="text-[15px] text-admin-ink [overflow-wrap:anywhere]">
                  {purchase.titleSnapshot}
                </strong>
                <span className="text-[13px] text-admin-muted">
                  {methodLabel(purchase.method)} ·{" "}
                  {instant(purchase.purchasedAtMicros, shortDate)}
                </span>
              </div>
              <div className="grid shrink-0 justify-items-end gap-0.5">
                <strong className="text-[15px] text-admin-ink">
                  {formatCents(purchase.quoted.totalCents)}
                </strong>
                <span className="text-xs text-admin-muted">
                  {formatCents(purchaseNetCents(purchase.quoted))} para vocês
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
