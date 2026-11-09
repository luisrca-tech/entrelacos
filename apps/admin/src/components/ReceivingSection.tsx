import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { AsaasDisclosure } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Landmark, Percent, UserRound } from "lucide-react";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { ReceivingStatusCard } from "../features/receiving/ReceivingStatusCard";
import { AdminButton } from "./AdminButton";
import { type FinanceLinks, FinanceSection } from "./FinanceSection";
import { loadGiftsReadiness } from "./giftsReadiness";
import { isCurrentPanelSessionEpoch, panelActorOwner } from "./panelActor";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";
import { ReceivingGuide } from "./ReceivingGuide";
import type { ReceivingStepSection } from "./ReceivingSteps";
import {
  isReadyReceivingPage,
  type ReadyReceivingPage,
  type ReceivingPage,
  ReceivingPageContext,
} from "./receivingNavigation";
import { loadReceivingOwnerAccess } from "./receivingOwnerAccess";
import {
  ReadyReceivingHeader,
  readyCard,
  receivingLink,
  receivingPrimaryAction,
  receivingStepTitle,
} from "./receivingUi";
import {
  loadSavedPixDestination,
  type SavedPixDestinationSummary,
} from "./savedPixDestination";

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
  const ready =
    current?.readiness?.siteId === siteId &&
    current.readiness.state === "READY";
  const [destination, setDestination] = useState<{
    siteId: string;
    value: SavedPixDestinationSummary | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setDestination(null);
    if (ready && !guide && sessionEpoch !== null)
      void loadSavedPixDestination(siteId).then((value) => {
        if (active && isCurrentPanelSessionEpoch(sessionEpoch))
          setDestination({ siteId, value });
      });
    return () => {
      active = false;
    };
  }, [siteId, ready, guide, sessionEpoch]);
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
      destination={destination?.siteId === siteId ? destination.value : null}
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
  destination = null,
}: {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  platformOwner?: boolean;
  readiness: ReceivingReadiness | null;
  failed: boolean;
  onRetry: () => void;
  page?: ReceivingPage;
  destination?: SavedPixDestinationSummary | null;
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
  const stepPage = !isReadyReceivingPage(page);
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
      destination={destination}
      action={
        ready ? (
          canChangeDestination(currentAccess) ? (
            <Link
              to="/sites/$siteId/receiving/$page"
              params={{ siteId, page: "account" }}
              className="font-semibold text-admin-success-text underline underline-offset-4"
            >
              Alterar
            </Link>
          ) : undefined
        ) : setupEligible ? (
          <AdminButton
            tone="primary"
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
          </AdminButton>
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
      pricingEnabled={canPreviewFees(platformOwner, currentAccess)}
    />
  );
  return (
    <div className="grid min-w-0 gap-6">
      <AsaasDisclosure />
      {platformOwner && !currentAccess ? (
        <section className="grid gap-3 rounded-2xl border border-admin-border bg-admin-surface p-6">
          <p role={failed ? "alert" : "status"}>
            {failed
              ? "Não foi possível consultar o acesso de leitura deste casamento."
              : "Consultando o acesso de leitura deste casamento…"}
          </p>
          <AdminButton tone="primary" className="w-fit" onClick={onRetry}>
            Verificar acesso
          </AdminButton>
        </section>
      ) : readinessPending ? (
        <>
          <ReceivingPageHeader />
          <section
            aria-busy="true"
            className="grid min-h-40 place-items-center rounded-2xl border border-admin-border bg-admin-surface p-6"
          >
            <p role="status" className="m-0 text-admin-text-secondary">
              Verificando os recebimentos…
            </p>
          </section>
        </>
      ) : ready && !stepPage ? (
        <ReadyReceiving
          siteId={siteId}
          page={page as ReadyReceivingPage}
          access={currentAccess}
          platformOwner={platformOwner}
          sessionEpoch={sessionEpoch}
          statusCard={statusCard}
          destination={destination}
          canChangeDestination={canChangeDestination(currentAccess)}
        />
      ) : page === "overview" ? (
        setupEligible && !ready && !failed ? (
          setupView("overview")
        ) : (
          <>
            <ReceivingPageHeader />
            {statusCard}
          </>
        )
      ) : stepPage ? (
        setupEligible ? (
          setupView(page as ReceivingStepSection)
        ) : (
          <>
            <ReceivingPageHeader />
            <p role="status" className="m-0 text-admin-text-secondary">
              Apenas o titular ou a equipe autorizada configura os recebimentos.
            </p>
          </>
        )
      ) : (
        <>
          <ReceivingPageHeader />
          <section className="grid gap-3 rounded-2xl border border-admin-border bg-admin-surface p-6">
            <p role="status" className="m-0 text-admin-text">
              {currentReadiness || failed
                ? "Pagamentos, saques e configurações aparecem aqui quando os recebimentos estiverem liberados."
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
      <p className="m-0 text-base leading-[1.6] text-admin-text-secondary">
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

function canPreviewFees(platformOwner: boolean, access: SiteAccess | null) {
  return (
    platformOwner ||
    access?.membershipRole === "OWNER" ||
    (access?.membershipRole === "SITE_ADMIN" &&
      access.capabilities.manageCatalog &&
      access.capabilities.readFinance)
  );
}

// Changing the Pix destination stays with the receiving holder's team.
function canChangeDestination(access: SiteAccess | null) {
  return (
    access?.membershipRole === "SITE_ADMIN" &&
    access.capabilities.configureReceiving
  );
}

function ReadyReceiving({
  siteId,
  page,
  access,
  platformOwner,
  sessionEpoch,
  statusCard,
  destination,
  canChangeDestination,
}: {
  siteId: string;
  page: ReadyReceivingPage;
  access: SiteAccess | null;
  platformOwner: boolean;
  sessionEpoch: number | null;
  statusCard: ReactNode;
  destination: SavedPixDestinationSummary | null;
  canChangeDestination: boolean;
}) {
  const links: FinanceLinks = (target, label, variant = "link") => (
    <Link
      to="/sites/$siteId/receiving/$page"
      params={{ siteId, page: target }}
      className={
        variant === "primary"
          ? receivingPrimaryAction
          : "w-fit text-sm font-semibold whitespace-nowrap text-admin-accent-hover underline underline-offset-4 hover:text-admin-accent-hover"
      }
    >
      {label}
      {variant === "primary" && <span aria-hidden="true">→</span>}
    </Link>
  );
  return (
    <>
      <ReadyReceivingHeader siteId={siteId} page={page} />
      {page === "overview" && statusCard}
      {page === "settings" ? (
        <ReceivingSettings
          siteId={siteId}
          destination={destination}
          editable={canChangeDestination}
        />
      ) : (
        (!platformOwner || !!access) && (
          <FinanceSection
            page={page}
            siteId={siteId}
            access={access}
            sessionEpoch={sessionEpoch}
            destination={destination}
            links={(target, label, variant) =>
              target === "account" && !canChangeDestination
                ? null
                : links(target, label, variant)
            }
          />
        )
      )}
    </>
  );
}

function ReceivingSettings({
  siteId,
  destination,
  editable,
}: {
  siteId: string;
  destination: SavedPixDestinationSummary | null;
  editable: boolean;
}) {
  const items: {
    page: "account" | "fees" | "holder";
    title: string;
    text: string;
    icon: ReactNode;
  }[] = [
    {
      page: "account",
      title: "Conta para saque",
      text: destination
        ? `${destination.ownerName} · Chave Pix ${destination.maskedKey} · ${destination.bankName}`
        : "A chave Pix do seu banco, para onde o dinheiro vai.",
      icon: <Landmark className="size-[18px]" />,
    },
    {
      page: "fees",
      title: "Taxas",
      text: "As taxas estão incluídas no preço que o convidado vê.",
      icon: <Percent className="size-[18px]" />,
    },
    {
      page: "holder",
      title: "Titular",
      text: "Quem recebe os presentes e faz os saques.",
      icon: <UserRound className="size-[18px]" />,
    },
  ];
  return (
    <section aria-label="Configurações dos recebimentos" className="grid gap-3">
      <ul className="m-0 grid list-none gap-3 p-0">
        {items.map((item) => (
          <li key={item.page}>
            <Link
              to="/sites/$siteId/receiving/$page"
              params={{ siteId, page: item.page }}
              className={`${readyCard} flex min-h-[72px] items-center gap-4 px-5 py-4 text-admin-text no-underline transition-colors hover:border-admin-border-strong hover:bg-admin-canvas motion-reduce:transition-none`}
            >
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-admin-accent-subtle text-admin-accent-hover"
              >
                {item.icon}
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <strong className="text-base">{item.title}</strong>
                <span className="text-sm leading-[1.45] text-admin-text-secondary [overflow-wrap:anywhere]">
                  {item.text}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-admin-accent-hover">
                <span className="[@media(max-width:760px)]:sr-only">
                  {editable ? "Revisar" : "Ver"}
                </span>
                <ChevronRight aria-hidden="true" className="size-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
