import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { ReceivingStatusCard } from "../features/receiving/ReceivingStatusCard";
import { FinanceSection } from "./FinanceSection";
import { loadGiftsReadiness } from "./giftsReadiness";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";
import { ReceivingGuide } from "./ReceivingGuide";
import {
  type ReceivingPage,
  ReceivingPageContext,
  receivingPages,
} from "./receivingNavigation";
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
  guide = false,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch?: number | null;
  platformOwner?: boolean;
  guide?: boolean;
}) {
  const page = useContext(ReceivingPageContext);
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
  if (guide) {
    return (
      <ReceivingGuide siteId={siteId} mode={current?.readiness?.mode ?? null} />
    );
  }
  return (
    <ReceivingSectionView
      page={page}
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
  page = "overview",
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  platformOwner?: boolean;
  readiness: ReceivingReadiness | null;
  failed: boolean;
  onRetry: () => void;
  page?: ReceivingPage;
}) {
  const currentAccess =
    sessionEpoch !== null && access?.siteId === siteId ? access : null;
  return (
    <div className="grid gap-6">
      <nav
        aria-label="Páginas de recebimentos"
        className="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-admin-line bg-admin-surface p-1.5"
      >
        {receivingPages.map((item) => (
          <Link
            key={item.id}
            activeOptions={{ exact: true }}
            to={
              item.id === "overview"
                ? "/sites/$siteId/receiving"
                : "/sites/$siteId/receiving/$page"
            }
            params={{ siteId, page: item.id }}
            aria-current={page === item.id ? "page" : undefined}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold no-underline transition-colors ${page === item.id ? "bg-admin-graphite text-white" : "text-admin-muted hover:bg-admin-paper hover:text-admin-graphite"}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {page === "activation" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-sm text-admin-muted">
            {readiness?.state === "READY"
              ? "Consulte o cadastro e as verificações dos recebimentos."
              : "Conclua o cadastro e acompanhe a liberação dos recebimentos."}
          </p>
          <Link
            className="text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4"
            to="/sites/$siteId/receiving-guide"
            params={{ siteId }}
          >
            Ajuda com a ativação
          </Link>
        </div>
      )}
      {page === "overview" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-sm text-admin-muted">
            Acompanhe seus presentes e encontre o próximo passo.
          </p>
          <Link
            className="text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4"
            to="/sites/$siteId/receiving-guide"
            params={{ siteId }}
          >
            Como funciona
          </Link>
        </div>
      )}
      {platformOwner && !currentAccess ? (
        <section className="grid gap-3 rounded-xl border border-admin-line bg-admin-surface p-6">
          <p role={failed ? "alert" : "status"}>
            {failed
              ? "Não foi possível consultar o acesso de leitura deste casamento."
              : "Consultando o acesso de leitura deste casamento…"}
          </p>
          <Button onClick={onRetry}>Verificar acesso</Button>
        </section>
      ) : page === "overview" ? (
        <ReceivingStatusCard
          siteId={siteId}
          access={currentAccess}
          readiness={
            currentAccess && readiness?.siteId === siteId ? readiness : null
          }
          error={!!currentAccess && failed}
          onRetry={onRetry}
          action={
            <Button
              className="w-fit"
              nativeButton={false}
              render={
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{
                    siteId,
                    page:
                      readiness?.state === "READY"
                        ? "withdrawals"
                        : "activation",
                  }}
                />
              }
            >
              {readiness?.state === "READY"
                ? "Ver saques"
                : "Acompanhar ativação"}
            </Button>
          }
        />
      ) : null}
      {(page === "activation" || page === "account") &&
        ((sessionEpoch !== null && platformOwner) ||
          currentAccess?.membershipRole === "OWNER" ||
          (currentAccess?.membershipRole === "SITE_ADMIN" &&
            currentAccess.capabilities.configureReceiving)) && (
          <ReceivingAccountSetup
            siteId={siteId}
            access={currentAccess}
            platformOwner={platformOwner}
            sessionEpoch={sessionEpoch}
            onReadinessChange={onRetry}
            section={page === "account" ? "account" : "activation"}
            readiness={readiness}
          />
        )}
      {(page === "overview" || page === "payments" || page === "withdrawals") &&
        (!platformOwner || !!currentAccess) && (
          <FinanceSection
            page={
              page === "payments"
                ? "payments"
                : page === "withdrawals"
                  ? "withdrawals"
                  : "overview"
            }
            siteId={siteId}
            access={currentAccess}
            sessionEpoch={sessionEpoch}
          />
        )}
    </div>
  );
}
