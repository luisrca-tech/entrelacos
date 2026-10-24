import {
  type ReceivingReadiness,
  receivingReadinessSchema,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { Button, showSandboxNotice } from "@entrelacos/ui";
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
  action,
}: {
  siteId: string;
  readiness: ReceivingReadiness | null;
  access: SiteAccess | null;
  error?: boolean;
  onRetry: () => void;
  action?: ReactNode;
}) {
  const parsedAccess = siteAccessSchema.safeParse(access);
  const canReadStatus =
    parsedAccess.success &&
    parsedAccess.data.siteId === siteId &&
    ((parsedAccess.data.membershipRole === "SITE_ADMIN" &&
      parsedAccess.data.capabilities.configureReceiving) ||
      (parsedAccess.data.membershipRole === "OWNER" &&
        parsedAccess.data.membershipId === null &&
        parsedAccess.data.capabilities.readFinance &&
        !parsedAccess.data.capabilities.configureReceiving &&
        !parsedAccess.data.capabilities.requestWithdrawal));

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
        <p role="status" className={bodyClassName}>
          Não foi possível confirmar o status dos recebimentos. A configuração
          permanece pendente.
        </p>
      );
    } else if (current.state === "READY" && showSandboxNotice(current.mode)) {
      title = "Pronto no ambiente de testes";
      content = (
        <p role="status" className={bodyClassName}>
          Sandbox — status válido apenas para testes, sem movimentação de
          dinheiro real.
        </p>
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
          {showSandboxNotice(current.mode) && (
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
          <p className="m-0 text-sm text-admin-muted">
            Acompanhe a etapa pendente em Ativação.
          </p>
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
      {canReadStatus && !error && readiness && action}
    </section>
  );
}
