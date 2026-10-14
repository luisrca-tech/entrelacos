import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { useEffect, useState } from "react";
import { ReceivingStatusCard } from "../features/receiving/ReceivingStatusCard";
import { FinanceSection } from "./FinanceSection";
import { loadGiftsReadiness } from "./giftsReadiness";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReceivingSetup } from "./ReceivingSetup";

type ReceivingSectionResult = {
  siteId: string;
  epoch: number;
  readiness: ReceivingReadiness | null;
  failed: boolean;
};
export async function readReceivingSection(
  siteId: string,
  epoch: number | null,
  receive: (result: ReceivingSectionResult) => void,
  isActive: () => boolean = () => true,
) {
  if (epoch === null || !isActive() || !isCurrentPanelSessionEpoch(epoch))
    return;
  try {
    const readiness = await loadGiftsReadiness(siteId);
    if (isActive() && isCurrentPanelSessionEpoch(epoch))
      receive({ siteId, epoch, readiness, failed: false });
  } catch (cause) {
    if (!isActive() || !isCurrentPanelSessionEpoch(epoch)) return;
    panelActorOwner.reportFailure(cause, epoch);
    if (isCurrentPanelSessionEpoch(epoch))
      receive({ siteId, epoch, readiness: null, failed: true });
  }
}

export function ReceivingSection({
  siteId,
  access,
  sessionEpoch = null,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch?: number | null;
}) {
  const [result, setResult] = useState<ReceivingSectionResult | null>(null);
  const [revision, setRevision] = useState(0);
  const eligible =
    sessionEpoch !== null &&
    access?.siteId === siteId &&
    access.membershipRole === "SITE_ADMIN" &&
    access.capabilities.configureReceiving;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry repeats this site's status request.
  useEffect(() => {
    let active = true;
    setResult(null);
    if (eligible)
      void readReceivingSection(siteId, sessionEpoch, setResult, () => active);
    return () => {
      active = false;
    };
  }, [siteId, eligible, revision, sessionEpoch]);
  const current =
    result?.siteId === siteId && result.epoch === sessionEpoch ? result : null;
  return (
    <ReceivingSectionView
      siteId={siteId}
      access={access}
      sessionEpoch={sessionEpoch}
      readiness={current?.readiness ?? null}
      failed={current?.failed ?? false}
      onRetry={() => setRevision((value) => value + 1)}
    />
  );
}

export function ReceivingSectionView({
  siteId,
  access,
  sessionEpoch,
  readiness,
  failed,
  onRetry,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  readiness: ReceivingReadiness | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const currentAccess =
    sessionEpoch !== null && access?.siteId === siteId ? access : null;
  return (
    <div className="grid gap-6">
      <ReceivingStatusCard
        siteId={siteId}
        access={currentAccess}
        readiness={
          currentAccess && readiness?.siteId === siteId ? readiness : null
        }
        error={!!currentAccess && failed}
        onRetry={onRetry}
      />
      {currentAccess?.membershipRole === "SITE_ADMIN" &&
        currentAccess.capabilities.configureReceiving && (
          <ReceivingSetup
            siteId={siteId}
            access={currentAccess}
            sessionEpoch={sessionEpoch}
          />
        )}
      <FinanceSection
        siteId={siteId}
        access={currentAccess}
        sessionEpoch={sessionEpoch}
      />
    </div>
  );
}
