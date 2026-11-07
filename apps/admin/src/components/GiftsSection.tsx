import type { ReceivingReadiness } from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { displayHeading } from "../lib/adminStyles";
import { AdminButton } from "./AdminButton";
import { GiftEditor } from "./GiftEditor";
import { GiftsLocked } from "./GiftsLocked";
import {
  type GiftCatalogReadiness,
  loadGiftsReadiness,
} from "./giftsReadiness";

const pendingReasons: Record<
  NonNullable<ReceivingReadiness["reason"]>,
  string
> = {
  NOT_CONFIGURED: "Os recebimentos ainda não foram configurados.",
  PROVIDER_DISABLED:
    "Os recebimentos ainda não estão disponíveis para ativação.",
  ONBOARDING_REQUIRED:
    "O recebedor precisa concluir seu cadastro e a verificação de identidade.",
  ACCOUNT_UNDER_REVIEW: "O cadastro do recebedor está em análise.",
  BANK_VERIFICATION_REQUIRED:
    "A conta de destino ainda precisa de verificação.",
  EVIDENCE_STALE: "A verificação dos recebimentos precisa ser atualizada.",
  DESTINATION_CHANGED:
    "A conta de destino mudou e precisa de nova verificação.",
  ENVIRONMENT_MISMATCH: "A configuração de recebimentos precisa ser revisada.",
  CAPABILITY_UNAVAILABLE:
    "Há uma etapa de habilitação dos recebimentos pendente.",
  ACCOUNT_BLOCKED:
    "Os recebimentos estão bloqueados. Entre em contato com o suporte.",
};

export function GiftsSection({
  siteId,
  receivingAction,
  canManage,
}: {
  siteId: string;
  receivingAction?: ReactNode;
  canManage: boolean;
}) {
  const [readiness, setReadiness] = useState<GiftCatalogReadiness | null>(null);
  const [failedSite, setFailedSite] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must repeat the same site's authoritative request.
  useEffect(() => {
    let active = true;
    setReadiness(null);
    setFailedSite(null);
    if (canManage)
      void loadGiftsReadiness(siteId)
        .then((result) => {
          if (active) setReadiness(result);
        })
        .catch(() => {
          if (active) setFailedSite(siteId);
        });
    return () => {
      active = false;
    };
  }, [siteId, revision, canManage]);

  if (!canManage)
    return (
      <div className="grid gap-4">
        <GiftsPageHeader />
        <p role="status" className="m-0 text-admin-text-secondary">
          Você não tem acesso ao catálogo deste casamento.
        </p>
      </div>
    );

  return (
    <GiftsReadinessView
      siteId={siteId}
      readiness={readiness}
      error={failedSite === siteId}
      receivingAction={receivingAction}
      onRetry={retry}
      catalog={
        <GiftEditor key={siteId} siteId={siteId} onEligibilityChanged={retry} />
      }
    />
  );
}

export function GiftsReadinessView({
  siteId,
  readiness,
  error,
  onRetry,
  receivingAction,
  catalog,
}: {
  siteId: string;
  readiness: GiftCatalogReadiness | null;
  error?: boolean;
  onRetry: () => void;
  receivingAction?: ReactNode;
  catalog?: ReactNode;
}) {
  const current = readiness?.siteId === siteId ? readiness : null;
  if (error)
    return (
      <div className="grid gap-4">
        <GiftsPageHeader />
        <p role="alert" className="m-0 text-admin-text-secondary">
          Não foi possível verificar os recebimentos. Os presentes continuam
          bloqueados.
        </p>
        <div>
          <AdminButton type="button" tone="secondary" onClick={onRetry}>
            Tentar novamente
          </AdminButton>
        </div>
        <GiftsLocked receivingAction={receivingAction} />
      </div>
    );
  if (!current)
    return (
      <div className="grid gap-4">
        <GiftsPageHeader />
        <p role="status" className="m-0 text-admin-text-secondary">
          Verificando os recebimentos…
        </p>
      </div>
    );

  const demonstration =
    current.catalogAccess?.siteId === siteId &&
    current.catalogAccess.mode === "demonstration" &&
    !current.catalogEligible;
  return (
    <div className="grid gap-4">
      {demonstration && (
        <p role="status" className="m-0 text-sm text-admin-text-secondary">
          Catálogo de demonstração. Você pode gerenciar os presentes;
          contribuições e recebimentos continuam indisponíveis.
        </p>
      )}
      {showSandboxNotice(current.mode) && (
        <p className="m-0 text-sm text-admin-text-secondary">
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}
      {current.catalogEligible || demonstration ? (
        (catalog ?? (
          <section className="rounded-xl border border-admin-border bg-admin-surface p-6">
            <h2 className="m-0 font-admin-display text-2xl">
              Recebimentos verificados
            </h2>
            <p className="mb-0 text-admin-text-secondary">
              Aguarde o carregamento do catálogo de presentes.
            </p>
          </section>
        ))
      ) : (
        <>
          <GiftsPageHeader />
          <GiftsLocked
            receivingAction={receivingAction}
            reason={
              current.reason
                ? pendingReasons[current.reason]
                : "Os recebimentos precisam ser verificados."
            }
          />
        </>
      )}
    </div>
  );
}

function GiftsPageHeader() {
  return (
    <header className="grid max-w-[600px] gap-2">
      <h1
        className={`m-0 text-[clamp(1.85rem,3vw,2.25rem)] text-admin-text ${displayHeading}`}
      >
        Lista de presentes
      </h1>
      <p className="m-0 text-base leading-[1.6] text-admin-text-secondary">
        Cada presente é uma contribuição simbólica em dinheiro para vocês, sem
        produto ou entrega.
      </p>
    </header>
  );
}
