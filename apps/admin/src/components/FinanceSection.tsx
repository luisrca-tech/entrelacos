import type {
  FinancialOverview,
  SiteAccess,
  WithdrawalPage,
} from "@entrelacos/contracts";
import { Landmark } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BalanceFigure,
  currentOverview,
  FinancialOverviewCard,
  OverviewNotice,
} from "../features/finance/FinancialOverviewCard";
import { destinationKeyLabel } from "../features/receiving/ReceivingStatusCard";
import { adminStyles } from "../lib/adminStyles";
import { AdminButton } from "./AdminButton";
import { formatCents } from "./financialFlow";
import {
  canReadFinancialOverview,
  loadFinancialOverview,
} from "./financialOverview";
import {
  currentFinancialRead,
  observeFinancialRead,
  type ScopedFinancialRead,
} from "./financialRead";
import {
  GiftPaymentHistoryView,
  RecentGiftPurchases,
  useGiftPaymentHistory,
} from "./GiftPaymentHistoryView";
import type { HistoryPorts } from "./giftPaymentHistory";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReadOnlyNote, readyCard, readyLabel } from "./receivingUi";
import type { SavedPixDestinationSummary } from "./savedPixDestination";
import {
  RecentWithdrawals,
  WithdrawalHistoryView,
} from "./WithdrawalHistoryView";
import { WithdrawalSetup } from "./WithdrawalSetup";
import {
  loadWithdrawalHistory,
  type WithdrawalHistoryResult,
} from "./withdrawalHistory";

type SessionFinancialRead<T> = ScopedFinancialRead<T> & {
  sessionEpoch: number | null;
};
export type FinanceLinkTarget = "payments" | "withdrawals" | "account";
// Router links come from the caller so this section stays router-agnostic.
export type FinanceLinks = (
  target: FinanceLinkTarget,
  label: string,
  variant?: "primary" | "link",
) => ReactNode;

export function FinanceSection({
  siteId,
  access,
  sessionEpoch = null,
  historyPorts,
  page = "overview",
  destination = null,
  links,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch?: number | null;
  historyPorts?: HistoryPorts;
  page?: "overview" | "payments" | "withdrawals";
  destination?: SavedPixDestinationSummary | null;
  links?: FinanceLinks;
}) {
  const [overviewRead, setOverviewRead] =
    useState<SessionFinancialRead<FinancialOverview> | null>(null);
  const [historyRead, setHistoryRead] =
    useState<SessionFinancialRead<WithdrawalPage> | null>(null);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [nextHistoryState, setNextHistoryState] = useState<
    "loading" | "error" | null
  >(null);
  const historyRequest = useRef(0);
  const eligible = canReadFinancialOverview(siteId, access);
  const liveScope = useRef({ siteId, access, sessionEpoch, eligible });
  liveScope.current = { siteId, access, sessionEpoch, eligible };
  const onFinancialChange = useCallback(() => {
    const live = liveScope.current;
    if (
      !live.eligible ||
      live.siteId !== siteId ||
      live.access !== access ||
      live.sessionEpoch !== sessionEpoch
    )
      return;
    setOverviewRevision((value) => value + 1);
    setHistoryRevision((value) => value + 1);
  }, [siteId, access, sessionEpoch]);
  useEffect(() => {
    if (!eligible) {
      setOverviewRead(null);
      return;
    }
    return observeFinancialRead(
      () => loadFinancialOverview(siteId, access),
      (result) =>
        setOverviewRead({
          siteId,
          access,
          sessionEpoch,
          revision: overviewRevision,
          result,
        }),
    );
  }, [siteId, access, eligible, sessionEpoch, overviewRevision]);
  useEffect(() => {
    setNextHistoryState(null);
    if (!eligible || page === "payments") {
      setHistoryRead(null);
      return;
    }
    const stop = observeFinancialRead(
      () => loadWithdrawalHistory(siteId, access),
      (result) =>
        setHistoryRead({
          siteId,
          access,
          sessionEpoch,
          revision: historyRevision,
          result,
        }),
    );
    return () => {
      historyRequest.current++;
      stop();
    };
  }, [siteId, access, eligible, sessionEpoch, historyRevision, page]);
  const overview = currentFinancialRead(
    overviewRead?.sessionEpoch === sessionEpoch ? overviewRead : null,
    siteId,
    access,
    overviewRevision,
  );
  const history = currentFinancialRead(
    historyRead?.sessionEpoch === sessionEpoch ? historyRead : null,
    siteId,
    access,
    historyRevision,
  );
  const historyResult: WithdrawalHistoryResult =
    history?.status === "ready"
      ? { status: "ready", ...history.value }
      : (history ?? { status: "loading" });
  async function loadMoreHistory(cursor: string) {
    if (
      !eligible ||
      history?.status !== "ready" ||
      history.value.nextCursor !== cursor ||
      !isCurrentPanelSessionEpoch(sessionEpoch)
    )
      return;
    const version = ++historyRequest.current;
    const current = () =>
      historyRequest.current === version &&
      isCurrentPanelSessionEpoch(sessionEpoch);
    setNextHistoryState("loading");
    try {
      const next = await loadWithdrawalHistory(
        siteId,
        access,
        undefined,
        cursor,
      );
      if (!current()) return;
      const combined = [
        ...new Map(
          [...history.value.withdrawals, ...next.withdrawals].map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ];
      setHistoryRead((previous) =>
        previous === historyRead && previous
          ? {
              ...previous,
              result: {
                status: "ready",
                value: { withdrawals: combined, nextCursor: next.nextCursor },
              },
            }
          : previous,
      );
      setNextHistoryState(null);
    } catch (cause) {
      if (!current()) return;
      panelActorOwner.reportFailure(cause, sessionEpoch);
      if (current()) setNextHistoryState("error");
    }
  }
  const overviewValue =
    overview?.status === "ready"
      ? currentOverview(siteId, access, overview.value)
      : null;
  const overviewLoading =
    eligible && (!overview || overview.status === "loading");
  const overviewFailed =
    overview?.status === "error" || overview?.status === "unavailable";
  const retryOverview = () => setOverviewRevision((value) => value + 1);
  const owner = eligible && access?.membershipRole === "OWNER";
  const canWithdraw =
    eligible &&
    access?.membershipRole === "SITE_ADMIN" &&
    access.capabilities.requestWithdrawal;
  if (page === "payments")
    return (
      <GiftPaymentHistoryView
        siteId={siteId}
        access={access}
        sessionEpoch={sessionEpoch}
        ports={historyPorts}
        totals={{ overview: overviewValue, loading: overviewLoading }}
      />
    );
  if (page === "overview")
    return (
      <div className="grid min-w-0 gap-5">
        {owner && (
          <ReadOnlyNote>
            Você está vendo como proprietário, só para consulta. Saques e dados
            cadastrais ficam com a pessoa titular dos recebimentos.
          </ReadOnlyNote>
        )}
        <FinancialOverviewCard
          siteId={siteId}
          access={access}
          overview={overview?.status === "ready" ? overview.value : null}
          loading={overviewLoading}
          error={overviewFailed}
          onRetry={retryOverview}
          withdrawAction={
            canWithdraw
              ? links?.("withdrawals", "Sacar para minha conta", "primary")
              : undefined
          }
          paymentsLink={links?.("payments", "Ver pagamentos")}
        />
        <p className={`m-0 text-sm ${adminStyles.notice}`}>
          <strong>Saques via Pix gratuitos para PF e MEI.</strong> Sem limite de
          quantidade para contas recebedoras cadastradas nessas categorias. Para
          outros tipos de empresa, consulte as taxas na prévia do saque.
        </p>
        {eligible && (
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <RecentGifts
              siteId={siteId}
              access={access}
              sessionEpoch={sessionEpoch}
              ports={historyPorts}
              viewAll={links?.("payments", "Ver todos")}
            />
            <RecentWithdrawals
              siteId={siteId}
              access={access}
              result={historyResult}
              viewAll={links?.("withdrawals", "Ver todos")}
            />
          </div>
        )}
      </div>
    );
  return (
    <div className="grid min-w-0 gap-5">
      {eligible ? (
        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section
            aria-labelledby="withdrawal-balance-title"
            className={`${readyCard} grid min-w-0 gap-[18px] px-7 py-[26px] [@media(max-width:760px)]:px-5`}
          >
            <h2 id="withdrawal-balance-title" className={readyLabel}>
              Disponível para saque
            </h2>
            <WithdrawalBalance
              loading={overviewLoading}
              failed={overviewFailed}
              overview={overviewValue}
              onRetry={retryOverview}
            />
            {destination && (
              <div className="flex min-w-0 items-center gap-3 rounded-xl bg-admin-canvas px-4 py-3.5">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-admin-accent-subtle text-admin-accent-hover"
                >
                  <Landmark className="size-[18px]" />
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-sm text-admin-text [overflow-wrap:anywhere]">
                    Destino: {destination.ownerName}
                  </strong>
                  <span className="text-[13px] text-admin-text-secondary [overflow-wrap:anywhere]">
                    Chave Pix {destinationKeyLabel(destination)} ·{" "}
                    {destination.bankName}
                  </span>
                </div>
                {!owner && links?.("account", "Alterar")}
              </div>
            )}
            {access?.membershipRole === "SITE_ADMIN" &&
            sessionEpoch !== null ? (
              <WithdrawalSetup
                siteId={siteId}
                access={access}
                sessionEpoch={sessionEpoch}
                onFinancialChange={onFinancialChange}
                collapsible
                availableCents={
                  overviewValue?.availability === "CURRENT"
                    ? overviewValue.availableCents
                    : null
                }
              />
            ) : (
              owner && (
                <p className="m-0 border-t border-admin-subtle pt-[18px] text-sm text-admin-text-secondary">
                  Você está vendo como proprietário, só para consulta. Os saques
                  ficam com a pessoa titular dos recebimentos.
                </p>
              )
            )}
          </section>
          <aside
            aria-labelledby="withdrawal-help-title"
            className={`${readyCard} grid min-w-0 gap-2.5 p-[22px]`}
          >
            <h2
              id="withdrawal-help-title"
              className="m-0 text-base font-bold text-admin-text"
            >
              Como funciona o saque
            </h2>
            <p className="m-0 text-sm leading-[1.5] text-admin-text">
              <strong>Saques via Pix gratuitos e ilimitados</strong> para contas
              recebedoras de pessoa física (PF) e MEI. Para outros tipos de
              empresa, consulte as taxas na prévia.
            </p>
            <ol className="m-0 grid list-decimal gap-2 pl-[18px] text-sm leading-[1.5] text-admin-text marker:text-admin-text-secondary">
              <li>Escolha o valor e confira a prévia.</li>
              <li>Confirme com sua senha do EntreLaços.</li>
              <li>O Asaas transfere por Pix para a sua chave.</li>
            </ol>
            <p className="m-0 text-[13px] text-admin-text-secondary">
              Só a pessoa titular dos recebimentos pode sacar.
            </p>
          </aside>
        </div>
      ) : (
        <OverviewNotice title="Acesso financeiro restrito">
          <p className="m-0">
            Apenas os administradores autorizados deste casamento podem
            consultar valores e movimentações.
          </p>
        </OverviewNotice>
      )}
      <WithdrawalHistoryView
        siteId={siteId}
        access={access}
        result={historyResult}
        onRefresh={() => setHistoryRevision((value) => value + 1)}
        onLoadMore={loadMoreHistory}
        loadingMore={nextHistoryState === "loading"}
        pageError={nextHistoryState === "error"}
      />
    </div>
  );
}

function WithdrawalBalance({
  loading,
  failed,
  overview,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  overview: FinancialOverview | null;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <p role="status" className="m-0 text-[15px] text-admin-text-secondary">
        Consultando o saldo…
      </p>
    );
  if (!overview)
    return (
      <div className="grid gap-2">
        <p
          role={failed ? "alert" : "status"}
          className="m-0 text-[15px] text-admin-text"
        >
          Não foi possível confirmar o saldo agora.
        </p>
        <div>
          <AdminButton type="button" tone="secondary" onClick={onRetry}>
            Tentar novamente
          </AdminButton>
        </div>
      </div>
    );
  return (
    <div className="grid gap-2">
      <BalanceFigure overview={overview} size="md" />
      {overview.awaitingReleaseCents > 0 && (
        <p className="m-0 text-[13px] text-admin-text-secondary">
          Dos pagamentos confirmados,{" "}
          {formatCents(overview.awaitingReleaseCents)} ainda aguardam liberação
          pelo Asaas. No cartão parcelado, cada parcela é liberada
          separadamente.
        </p>
      )}
    </div>
  );
}

function RecentGifts({
  siteId,
  access,
  sessionEpoch,
  ports,
  viewAll,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  ports?: HistoryPorts;
  viewAll: ReactNode;
}) {
  const history = useGiftPaymentHistory({
    siteId,
    access,
    sessionEpoch,
    ports,
  });
  return <RecentGiftPurchases history={history} viewAll={viewAll} />;
}
