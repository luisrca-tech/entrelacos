import {
  type ReceivingReadiness,
  receivingReadinessSchema,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import type { ReactNode } from "react";

const reasonMessages: Record<
  NonNullable<ReceivingReadiness["reason"]>,
  string
> = {
  NOT_CONFIGURED: "Os recebimentos ainda não foram configurados.",
  PROVIDER_DISABLED:
    "Os recebimentos ainda não estão disponíveis para ativação.",
  ONBOARDING_REQUIRED:
    "O recebedor precisa concluir a verificação dos seus dados.",
  ACCOUNT_UNDER_REVIEW: "O cadastro do recebedor está em análise.",
  BANK_VERIFICATION_REQUIRED:
    "A conta de destino ainda precisa ser verificada.",
  EVIDENCE_STALE: "A verificação dos recebimentos precisa ser atualizada.",
  DESTINATION_CHANGED:
    "A conta de destino mudou e precisa de nova verificação.",
  ENVIRONMENT_MISMATCH: "O ambiente de recebimentos precisa ser revisado.",
  CAPABILITY_UNAVAILABLE: "A ativação dos recebimentos ainda está pendente.",
  ACCOUNT_BLOCKED:
    "Os recebimentos estão bloqueados. Entre em contato com o suporte.",
};

const activationGuidance =
  "Para ativar, o recebedor e a conta de destino precisam ser verificados no fluxo do Asaas. A ativação ainda depende da habilitação dos recebimentos.";
const cardClassName =
  "grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8";
const eyebrowClassName =
  "m-0 text-xs font-bold uppercase tracking-wider text-admin-muted";
const titleClassName = "m-0 font-admin-display text-2xl text-admin-graphite";
const bodyClassName = "m-0 max-w-2xl leading-relaxed text-admin-muted";

export function ReceivingStatusCard({
  siteId,
  readiness,
  access,
  error = false,
  onRetry,
}: {
  siteId: string;
  readiness: ReceivingReadiness | null;
  access: SiteAccess | null;
  error?: boolean;
  onRetry: () => void;
}) {
  const parsedAccess = siteAccessSchema.safeParse(access);
  const canReadStatus =
    parsedAccess.success &&
    parsedAccess.data.siteId === siteId &&
    parsedAccess.data.membershipRole === "SITE_ADMIN" &&
    parsedAccess.data.capabilities.configureReceiving;

  let title = "Status dos recebimentos";
  let content: ReactNode;

  if (!canReadStatus) {
    content = (
      <p role="status" className={bodyClassName}>
        Apenas o administrador do site pode consultar o status dos recebimentos.
      </p>
    );
  } else if (error) {
    title = "Não foi possível consultar o status";
    content = (
      <>
        <p role="alert" className={bodyClassName}>
          Não foi possível verificar os recebimentos. O status permanece
          indisponível.
        </p>
        <div>
          <Button type="button" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      </>
    );
  } else if (readiness === null) {
    title = "Verificando os recebimentos";
    content = (
      <p role="status" className={bodyClassName}>
        Aguarde enquanto consultamos o status deste site.
      </p>
    );
  } else {
    const parsedReadiness = receivingReadinessSchema.safeParse(readiness);
    const current =
      parsedReadiness.success && parsedReadiness.data.siteId === siteId
        ? parsedReadiness.data
        : null;

    if (!current) {
      title = "Status dos recebimentos indisponível";
      content = (
        <>
          <p role="status" className={bodyClassName}>
            Não foi possível confirmar o status dos recebimentos. A configuração
            permanece pendente.
          </p>
          <p className={bodyClassName}>{activationGuidance}</p>
        </>
      );
    } else if (current.state === "READY" && current.mode === "sandbox") {
      title = "Pronto no ambiente de testes";
      content = (
        <>
          <p role="status" className={bodyClassName}>
            Sandbox — status válido apenas para testes, sem movimentação de
            dinheiro real.
          </p>
          <p className={bodyClassName}>{activationGuidance}</p>
        </>
      );
    } else if (current.state === "READY") {
      title = "Recebimentos verificados";
      content = (
        <p role="status" className={bodyClassName}>
          O cadastro e a conta de destino foram verificados para este casamento.
        </p>
      );
    } else {
      title = "Configuração pendente";
      content = (
        <>
          {current.mode === "sandbox" && (
            <p className={bodyClassName}>
              Sandbox — status apenas para testes, sem movimentação de dinheiro
              real.
            </p>
          )}
          <p role="status" className={bodyClassName}>
            {current.reason
              ? reasonMessages[current.reason]
              : "Os recebimentos precisam ser verificados."}
          </p>
          <p className={bodyClassName}>{activationGuidance}</p>
        </>
      );
    }
  }

  return (
    <section className={cardClassName} aria-labelledby="receiving-status-title">
      <p className={eyebrowClassName}>Recebimentos</p>
      <h2 id="receiving-status-title" className={titleClassName}>
        {title}
      </h2>
      {content}
    </section>
  );
}
