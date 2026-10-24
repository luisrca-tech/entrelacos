import {
  type CheckoutStatus,
  checkoutStatusSchema,
} from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";

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
  "min-h-11 cursor-pointer border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";

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
  const needsVerification = loading || error || currentStatus === null;
  const checkout =
    currentStatus?.state === "AWAITING_PAYMENT" ? currentStatus.checkout : null;

  return (
    <section
      aria-label="Acompanhamento do pagamento"
      className="grid min-w-0 gap-5 text-template-ink"
    >
      {showSandboxNotice(currentStatus?.mode) && (
        <p
          role="status"
          className="m-0 border border-template-line px-4 py-3 text-sm"
        >
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}
      {needsVerification ? (
        <p role="status" className="m-0 border border-template-line p-4">
          Pagamento em verificação
        </p>
      ) : (
        <>
          <p role="status" className="m-0 border border-template-line p-4">
            {getStatusLabel(currentStatus)}
          </p>
          {currentStatus.state === "AWAITING_PAYMENT" &&
            checkout &&
            checkout.hostedUrl &&
            onContinue && (
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => onContinue(checkout)}
              >
                Continuar para pagamento
              </button>
            )}
        </>
      )}

      {error && (
        <p role="alert" className="m-0 border border-template-line p-4">
          Não foi possível consultar o status do pagamento.
        </p>
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
    </section>
  );
}
