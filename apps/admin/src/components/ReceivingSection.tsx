import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { useEffect, useState } from "react";
import { ReceivingStatusCard } from "../features/receiving/ReceivingStatusCard";
import { FinanceSection } from "./FinanceSection";
import { loadGiftsReadiness } from "./giftsReadiness";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";
import { loadReceivingOwnerAccess } from "./receivingOwnerAccess";

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
  platformOwner = false,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch?: number | null;
  platformOwner?: boolean;
}) {
  const [result, setResult] = useState<ReceivingSectionResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [ownerAccess, setOwnerAccess] = useState<{
    siteId: string;
    epoch: number;
    access: SiteAccess;
  } | null>(null);
  const [ownerAccessFailed, setOwnerAccessFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry rechecks server-owned selected-site access.
  useEffect(() => {
    let active = true;
    setOwnerAccess(null);
    setOwnerAccessFailed(false);
    if (platformOwner && sessionEpoch !== null)
      void loadReceivingOwnerAccess(siteId, sessionEpoch)
        .then((resolved) => {
          if (active && resolved && isCurrentPanelSessionEpoch(sessionEpoch))
            setOwnerAccess({ siteId, epoch: sessionEpoch, access: resolved });
        })
        .catch(() => {
          if (active && isCurrentPanelSessionEpoch(sessionEpoch))
            setOwnerAccessFailed(true);
        });
    return () => {
      active = false;
    };
  }, [siteId, sessionEpoch, platformOwner, revision]);
  const selectedAccess = platformOwner
    ? ownerAccess?.siteId === siteId && ownerAccess.epoch === sessionEpoch
      ? ownerAccess.access
      : null
    : access;
  const eligible =
    sessionEpoch !== null &&
    selectedAccess?.siteId === siteId &&
    ((selectedAccess.membershipRole === "SITE_ADMIN" &&
      selectedAccess.capabilities.configureReceiving) ||
      (selectedAccess.membershipRole === "OWNER" &&
        selectedAccess.capabilities.readFinance));
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
      access={selectedAccess}
      platformOwner={platformOwner}
      sessionEpoch={sessionEpoch}
      readiness={current?.readiness ?? null}
      failed={ownerAccessFailed || (current?.failed ?? false)}
      onRetry={() => setRevision((value) => value + 1)}
    />
  );
}

export function ReceivingSectionView({
  siteId,
  access,
  sessionEpoch,
  platformOwner = false,
  readiness,
  failed,
  onRetry,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  platformOwner?: boolean;
  readiness: ReceivingReadiness | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const currentAccess =
    sessionEpoch !== null && access?.siteId === siteId ? access : null;
  return (
    <div className="grid gap-6">
      {platformOwner && !currentAccess ? (
        <section className="grid gap-3 rounded-xl border border-admin-line bg-admin-surface p-6">
          <p role={failed ? "alert" : "status"}>
            {failed
              ? "Não foi possível consultar o acesso de leitura deste casamento."
              : "Consultando o acesso de leitura deste casamento…"}
          </p>
          <Button onClick={onRetry}>Verificar acesso</Button>
        </section>
      ) : (
        <ReceivingStatusCard
          siteId={siteId}
          access={currentAccess}
          readiness={
            currentAccess && readiness?.siteId === siteId ? readiness : null
          }
          error={!!currentAccess && failed}
          onRetry={onRetry}
        />
      )}
      {((sessionEpoch !== null && platformOwner) ||
        currentAccess?.membershipRole === "OWNER" ||
        (currentAccess?.membershipRole === "SITE_ADMIN" &&
          currentAccess.capabilities.configureReceiving)) && (
        <ReceivingAccountSetup
          siteId={siteId}
          access={currentAccess}
          platformOwner={platformOwner}
          sessionEpoch={sessionEpoch}
          onReadinessChange={onRetry}
        />
      )}
      {(!platformOwner || !!currentAccess) && (
        <FinanceSection
          siteId={siteId}
          access={currentAccess}
          sessionEpoch={sessionEpoch}
        />
      )}
    </div>
  );
}
