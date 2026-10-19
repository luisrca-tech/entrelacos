import type { ReceivingReadiness } from "@entrelacos/contracts";
import { Button, showSandboxNotice } from "@entrelacos/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { GiftEditor } from "./GiftEditor";
import { GiftsLocked } from "./GiftsLocked";
import { loadGiftsReadiness } from "./giftsReadiness";

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
  const [readiness, setReadiness] = useState<ReceivingReadiness | null>(null);
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
      <p role="status" className="text-admin-muted">
        Você não tem acesso ao catálogo deste casamento.
      </p>
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
  readiness: ReceivingReadiness | null;
  error?: boolean;
  onRetry: () => void;
  receivingAction?: ReactNode;
  catalog?: ReactNode;
}) {
  const current = readiness?.siteId === siteId ? readiness : null;
  if (error)
    return (
      <div className="grid gap-4">
        <p role="alert" className="m-0 text-admin-muted">
          Não foi possível verificar os recebimentos. Os presentes continuam
          bloqueados.
        </p>
        <div>
          <Button type="button" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
        <GiftsLocked />
      </div>
    );
  if (!current)
    return (
      <p role="status" className="text-admin-muted">
        Verificando os recebimentos…
      </p>
    );

  return (
    <div className="grid gap-4">
      {showSandboxNotice(current.mode) && (
        <p className="m-0 text-sm text-admin-muted">
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}
      {current.catalogEligible ? (
        (catalog ?? (
          <section className="rounded-xl border border-admin-line bg-admin-surface p-6">
            <h2 className="m-0 font-admin-display text-2xl">
              Recebimentos verificados
            </h2>
            <p className="mb-0 text-admin-muted">
              Aguarde o carregamento do catálogo de presentes.
            </p>
          </section>
        ))
      ) : (
        <>
          <p role="status" className="m-0 text-admin-muted">
            {current.reason
              ? pendingReasons[current.reason]
              : "Os recebimentos precisam ser verificados."}
          </p>
          <GiftsLocked receivingAction={receivingAction} />
        </>
      )}
    </div>
  );
}
