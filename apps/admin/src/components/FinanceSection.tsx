import type {
  FinancialOverview,
  SiteAccess,
  WithdrawalIntent,
} from "@entrelacos/contracts";
import { useEffect, useState } from "react";
import { FinancialOverviewCard } from "../features/finance/FinancialOverviewCard";
import {
  canReadFinancialOverview,
  loadFinancialOverview,
} from "./financialOverview";
import {
  currentFinancialRead,
  observeFinancialRead,
  type ScopedFinancialRead,
} from "./financialRead";
import { GiftPaymentHistoryView } from "./GiftPaymentHistoryView";
import type { HistoryPorts } from "./giftPaymentHistory";
import { WithdrawalHistoryView } from "./WithdrawalHistoryView";
import { WithdrawalSetup } from "./WithdrawalSetup";
import {
  loadWithdrawalHistory,
  type WithdrawalHistoryResult,
} from "./withdrawalHistory";

export function FinanceSection({
  siteId,
  access,
  sessionEpoch = null,
  historyPorts,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch?: number | null;
  historyPorts?: HistoryPorts;
}) {
  const [overviewRead, setOverviewRead] =
    useState<ScopedFinancialRead<FinancialOverview> | null>(null);
  const [historyRead, setHistoryRead] = useState<ScopedFinancialRead<
    WithdrawalIntent[]
  > | null>(null);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const eligible = canReadFinancialOverview(siteId, access);
  useEffect(() => {
    if (!eligible) {
      setOverviewRead(null);
      return;
    }
    return observeFinancialRead(
      () => loadFinancialOverview(siteId, access),
      (result) =>
        setOverviewRead({ siteId, access, revision: overviewRevision, result }),
    );
  }, [siteId, access, eligible, overviewRevision]);
  useEffect(() => {
    if (!eligible) {
      setHistoryRead(null);
      return;
    }
    return observeFinancialRead(
      () => loadWithdrawalHistory(siteId, access),
      (result) =>
        setHistoryRead({ siteId, access, revision: historyRevision, result }),
    );
  }, [siteId, access, eligible, historyRevision]);
  const overview = currentFinancialRead(
    overviewRead,
    siteId,
    access,
    overviewRevision,
  );
  const history = currentFinancialRead(
    historyRead,
    siteId,
    access,
    historyRevision,
  );
  const historyResult: WithdrawalHistoryResult =
    history?.status === "ready"
      ? { status: "ready", withdrawals: history.value }
      : (history ?? { status: "loading" });
  return (
    <div className="grid gap-6">
      {eligible && access?.membershipRole === "OWNER" && (
        <p className="m-0 text-admin-muted">
          Consulta administrativa em modo somente leitura. A confirmação
          cadastral e os saques permanecem restritos à titular.
        </p>
      )}
      <FinancialOverviewCard
        siteId={siteId}
        access={access}
        overview={overview?.status === "ready" ? overview.value : null}
        loading={eligible && (!overview || overview.status === "loading")}
        error={
          overview?.status === "error" || overview?.status === "unavailable"
        }
        onRetry={() => setOverviewRevision((value) => value + 1)}
      />
      <WithdrawalHistoryView
        siteId={siteId}
        access={access}
        result={historyResult}
        onRefresh={() => setHistoryRevision((value) => value + 1)}
      />
      {eligible &&
        access?.membershipRole === "SITE_ADMIN" &&
        sessionEpoch !== null && (
          <WithdrawalSetup
            siteId={siteId}
            access={access}
            sessionEpoch={sessionEpoch}
          />
        )}
      <GiftPaymentHistoryView
        siteId={siteId}
        access={access}
        sessionEpoch={sessionEpoch}
        ports={historyPorts}
      />
    </div>
  );
}
