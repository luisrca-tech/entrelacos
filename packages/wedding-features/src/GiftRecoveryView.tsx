import {
  type CheckoutStatus,
  checkoutStatusSchema,
} from "@entrelacos/contracts";
import { AsaasDisclosure, showSandboxNotice } from "@entrelacos/ui";

export type GiftRecoveryViewProps = {
  siteId: string;
  status: CheckoutStatus | null;
  loading?: boolean;
  error?: boolean;
  canRetry?: boolean;
  onRetry?: () => void;
  onContinue?: (checkout: NonNullable<CheckoutStatus["checkout"]>) => void;
};

const primaryButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-2.5 text-sm font-medium text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:cursor-not-allowed disabled:opacity-50";

function getStatusLabel(status: CheckoutStatus): string {
  switch (status.state) {
    case "CREATING":
    case "OUTCOME_UNKNOWN":
      return "Pagamento em verificação";
    case "AWAITING_PAYMENT":
      return "Pagamento aguardando conclusão";
    case "CONFIRMED":
      return "Pagamento aprovado. Aguardando liberação do valor.";
    case "RECEIVED":
      return "Recebimento confirmado";
    case "CLOSED_UNPAID":
      return "Pagamento encerrado sem recebimento";
    case "REFUNDED":
      return "Reembolso confirmado";
  }
}

export function GiftRecoveryView({
  siteId,
  status,
  loading = false,
  error = false,
  canRetry = false,
  onRetry,
  onContinue,
}: GiftRecoveryViewProps) {
  const parsed =
    status === null ? null : checkoutStatusSchema.safeParse(status);
  const currentStatus =
    parsed?.success && parsed.data.siteId === siteId ? parsed.data : null;
  const checkout =
    currentStatus?.state === "AWAITING_PAYMENT" ? currentStatus.checkout : null;
  const message = error
    ? "Não foi possível consultar o pagamento agora."
    : loading
      ? "Consultando pagamento…"
      : currentStatus
        ? getStatusLabel(currentStatus)
        : "Pagamento em verificação";

  return (
    <section
      aria-label="Acompanhamento do pagamento"
      className="grid min-w-0 max-w-2xl gap-3 rounded-xl border border-template-line bg-template-surface p-4 text-template-ink sm:p-5"
    >
      {showSandboxNotice(currentStatus?.mode) && (
        <p role="status" className="m-0 text-sm text-template-muted">
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}
      <p role={error ? "alert" : "status"} className="m-0 font-medium">
        {message}
      </p>
      {(checkout && !loading && !error && onContinue) ||
      (canRetry && onRetry) ? (
        <div className="flex flex-wrap gap-2">
          {checkout && !loading && !error && onContinue && (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => onContinue(checkout)}
            >
              Continuar para pagamento
            </button>
          )}
          {canRetry && onRetry && (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={loading}
              onClick={onRetry}
            >
              Consultar pagamento
            </button>
          )}
        </div>
      ) : null}
      <details className="text-sm text-template-muted [&_section]:mt-2">
        <summary className="w-fit cursor-pointer">Sobre o pagamento</summary>
        <AsaasDisclosure />
      </details>
    </section>
  );
}
