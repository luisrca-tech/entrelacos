import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { ReceivingStatusCard } from "../features/receiving/ReceivingStatusCard";
import { apiRequest } from "../lib/apiClient";
import { FinanceSection } from "./FinanceSection";
import { parsePricingSettings } from "./GiftPricingSettings";
import { loadGiftsReadiness } from "./giftsReadiness";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";
import { ReceivingGuide } from "./ReceivingGuide";
import type { ReceivingStepSection } from "./ReceivingSteps";
import {
  type ReceivingPage,
  ReceivingPageContext,
  receivingTabs,
} from "./receivingNavigation";
import { loadReceivingOwnerAccess } from "./receivingOwnerAccess";
import { receivingLink, receivingStepTitle } from "./receivingUi";

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
  const [feesChosen, setFeesChosen] = useState(false);
  const pricingReadable =
    eligible &&
    (platformOwner ||
      selectedAccess?.membershipRole === "OWNER" ||
      !!selectedAccess?.capabilities.manageCatalog);
  useEffect(() => {
    let active = true;
    setFeesChosen(false);
    if (pricingReadable && !guide && sessionEpoch !== null)
      void apiRequest(
        `/v1/sites/${encodeURIComponent(siteId)}/gift-pricing-settings`,
      )
        .then((value) => {
          if (active && isCurrentPanelSessionEpoch(sessionEpoch))
            setFeesChosen(parsePricingSettings(value, siteId).revision > 0);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [siteId, pricingReadable, guide, sessionEpoch]);
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
      feesChosen={feesChosen}
      onFeesChosen={() => setFeesChosen(true)}
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
  feesChosen = false,
  onFeesChosen,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  platformOwner?: boolean;
  readiness: ReceivingReadiness | null;
  failed: boolean;
  onRetry: () => void;
  page?: ReceivingPage;
  feesChosen?: boolean;
  onFeesChosen?: () => void;
}) {
  const currentAccess =
    sessionEpoch !== null && access?.siteId === siteId ? access : null;
  const currentReadiness =
    currentAccess && readiness?.siteId === siteId ? readiness : null;
  const ready = currentReadiness?.state === "READY";
  const setupEligible = canConfigureReceiving(
    platformOwner,
    sessionEpoch,
    currentAccess,
  );
  const tabs = receivingTabs(ready);
  const stepPage = !["overview", "payments", "withdrawals"].includes(page);
  // Until readiness answers, neither the guided setup nor the ready tabs are known.
  const readinessPending =
    !stepPage &&
    !failed &&
    !currentReadiness &&
    canReadReadiness(currentAccess);
  const statusCard = (
    <ReceivingStatusCard
      siteId={siteId}
      access={currentAccess}
      readiness={currentReadiness}
      error={!!currentAccess && failed}
      onRetry={onRetry}
      action={
        ready ? (
          <Button
            className="w-fit"
            nativeButton={false}
            render={
              <Link
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "withdrawals" }}
              />
            }
          >
            Ver saques
          </Button>
        ) : setupEligible ? (
          <Button
            className="w-fit"
            nativeButton={false}
            render={
              <Link
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "activation" }}
              />
            }
          >
            Acompanhar ativação
          </Button>
        ) : undefined
      }
    />
  );
  const setupView = (section: ReceivingStepSection) => (
    <ReceivingAccountSetup
      siteId={siteId}
      access={currentAccess}
      platformOwner={platformOwner}
      sessionEpoch={sessionEpoch}
      onReadinessChange={onRetry}
      section={section}
      readiness={readiness}
      feesChosen={feesChosen}
      onFeesChosen={onFeesChosen}
      pricingEnabled={canManageFees(platformOwner, currentAccess)}
    />
  );
  return (
    <div className="grid min-w-0 gap-6">
      {tabs.length > 0 && !stepPage && (
        <nav
          aria-label="Páginas de recebimentos"
          className="flex w-fit max-w-full min-w-0 gap-1 overflow-x-auto rounded-xl border border-admin-line bg-admin-surface p-1.5"
        >
          {tabs.map((item) => (
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
              className={`inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold no-underline transition-colors motion-reduce:transition-none ${page === item.id ? "bg-admin-graphite text-white" : "text-admin-muted hover:bg-admin-canvas hover:text-admin-graphite"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      {platformOwner && !currentAccess ? (
        <section className="grid gap-3 rounded-2xl border border-admin-line bg-admin-surface p-6">
          <p role={failed ? "alert" : "status"}>
            {failed
              ? "Não foi possível consultar o acesso de leitura deste casamento."
              : "Consultando o acesso de leitura deste casamento…"}
          </p>
          <Button className="w-fit" onClick={onRetry}>
            Verificar acesso
          </Button>
        </section>
      ) : readinessPending ? (
        <>
          <ReceivingPageHeader />
          <section
            aria-busy="true"
            className="grid min-h-40 place-items-center rounded-2xl border border-admin-line bg-admin-surface p-6"
          >
            <p role="status" className="m-0 text-admin-muted">
              Verificando os recebimentos…
            </p>
          </section>
        </>
      ) : page === "overview" ? (
        setupEligible && !ready && !failed ? (
          setupView("overview")
        ) : (
          <>
            <ReceivingPageHeader />
            {statusCard}
            {setupEligible && ready && (
              <p className="m-0 text-sm text-admin-muted">
                Configuração concluída. Para revisar, abra{" "}
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{ siteId, page: "account" }}
                  className={receivingLink}
                >
                  Conta para saque
                </Link>{" "}
                ou{" "}
                <Link
                  to="/sites/$siteId/receiving/$page"
                  params={{ siteId, page: "fees" }}
                  className={receivingLink}
                >
                  Taxas e presentes
                </Link>
                .
              </p>
            )}
            {(!platformOwner || !!currentAccess) && ready && (
              <FinanceSection
                page="overview"
                siteId={siteId}
                access={currentAccess}
                sessionEpoch={sessionEpoch}
              />
            )}
          </>
        )
      ) : stepPage ? (
        setupEligible ? (
          setupView(page as ReceivingStepSection)
        ) : (
          <>
            <ReceivingPageHeader />
            <p role="status" className="m-0 text-admin-muted">
              Apenas o titular ou a equipe autorizada configura os recebimentos.
            </p>
          </>
        )
      ) : ready ? (
        <>
          <ReceivingPageHeader />
          <FinanceSection
            page={page === "payments" ? "payments" : "withdrawals"}
            siteId={siteId}
            access={currentAccess}
            sessionEpoch={sessionEpoch}
          />
        </>
      ) : (
        <>
          <ReceivingPageHeader />
          <section className="grid gap-3 rounded-2xl border border-admin-line bg-admin-surface p-6">
            <p role="status" className="m-0 text-admin-body">
              {currentReadiness || failed
                ? "Pagamentos e saques aparecem aqui quando os recebimentos estiverem liberados."
                : "Verificando os recebimentos…"}
            </p>
            <Link
              to="/sites/$siteId/receiving"
              params={{ siteId }}
              className={`${receivingLink} w-fit text-sm`}
            >
              Ver a configuração dos recebimentos
            </Link>
          </section>
        </>
      )}
    </div>
  );
}

function ReceivingPageHeader() {
  return (
    <header className="grid gap-1.5">
      <h1 className={receivingStepTitle}>Recebimentos</h1>
      <p className="m-0 text-base leading-[1.6] text-admin-muted">
        Configure uma vez para receber os presentes em dinheiro e sacar para o
        seu banco.
      </p>
    </header>
  );
}

function canReadReadiness(access: SiteAccess | null) {
  return (
    (access?.membershipRole === "SITE_ADMIN" &&
      access.capabilities.configureReceiving) ||
    (access?.membershipRole === "OWNER" && access.capabilities.readFinance)
  );
}

export function canConfigureReceiving(
  platformOwner: boolean,
  sessionEpoch: number | null,
  access: SiteAccess | null,
) {
  return (
    (sessionEpoch !== null && platformOwner) ||
    access?.membershipRole === "OWNER" ||
    (access?.membershipRole === "SITE_ADMIN" &&
      access.capabilities.configureReceiving)
  );
}

function canManageFees(platformOwner: boolean, access: SiteAccess | null) {
  return (
    platformOwner ||
    access?.membershipRole === "OWNER" ||
    (access?.membershipRole === "SITE_ADMIN" &&
      access.capabilities.manageCatalog &&
      access.capabilities.readFinance)
  );
}
