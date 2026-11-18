import {
  type GiftCheckoutPix,
  type GiftCheckoutStatus,
  giftCheckoutStatusSchema,
} from "@entrelacos/contracts";
import { PaymentProviderDisclosure, showSandboxNotice } from "@entrelacos/ui";
import { GiftPixPayment } from "./GiftPixPayment";
import { siteDialogCloseClass } from "./SiteDialog";

export type GiftRecoveryViewProps = {
  siteId: string;
  status: GiftCheckoutStatus | null;
  /** Pix returned on creation, shown until the first status check answers. */
  pix?: GiftCheckoutPix | null;
  loading?: boolean;
  error?: boolean;
  canRetry?: boolean;
  onRetry?: () => void;
  /** Renders a dialog header labelled by this id. */
  headingId?: string;
  giftTitle?: string;
  onClose?: () => void;
};

const secondaryButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-line bg-transparent px-5 py-2.5 text-sm font-medium text-template-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-2.5 text-sm font-medium text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:cursor-not-allowed disabled:opacity-50";

function getStatusLabel(status: GiftCheckoutStatus): string {
  switch (status.state) {
    case "CREATING":
    case "OUTCOME_UNKNOWN":
      return "Pagamento em verificação";
    case "AWAITING_PAYMENT":
      return "Pagamento aguardando conclusão";
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
  pix: createdPix = null,
  loading = false,
  error = false,
  canRetry = false,
  onRetry,
  headingId,
  giftTitle,
  onClose,
}: GiftRecoveryViewProps) {
  const parsed =
    status === null ? null : giftCheckoutStatusSchema.safeParse(status);
  const currentStatus =
    parsed?.success && parsed.data.siteId === siteId ? parsed.data : null;
  const pix = currentStatus ? currentStatus.pix : createdPix;
  const message = error
    ? "Não foi possível consultar o pagamento agora."
    : loading
      ? "Consultando pagamento…"
      : pix
        ? "Aguardando o Pix"
        : currentStatus
          ? getStatusLabel(currentStatus)
          : "Pagamento em verificação";

  return (
    <section
      aria-label="Acompanhamento do pagamento"
      className={
        headingId
          ? "grid min-w-0 gap-4 text-template-ink"
          : "grid min-w-0 max-w-2xl gap-3 rounded-xl border border-template-line bg-template-surface p-4 text-template-ink sm:p-5"
      }
    >
      {headingId && (
        <header className="flex min-w-0 items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <h2
              id={headingId}
              className="m-0 font-template-serif text-[clamp(1.6rem,4vw,2.1rem)] font-normal leading-tight"
            >
              {pix ? "Pagar com Pix" : "Acompanhar pagamento"}
            </h2>
            {giftTitle && (
              <p className="m-0 break-words text-template-muted">{giftTitle}</p>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              className={siteDialogCloseClass}
              data-dialog-initial
              onClick={onClose}
            >
              Fechar
            </button>
          )}
        </header>
      )}
      {showSandboxNotice(currentStatus?.mode) && (
        <p role="status" className="m-0 text-sm text-template-muted">
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}
      <p role={error ? "alert" : "status"} className="m-0 font-medium">
        {message}
      </p>
      {pix ? (
        <GiftPixPayment pix={pix}>
          {canRetry && onRetry && (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={loading}
              onClick={onRetry}
            >
              Já paguei
            </button>
          )}
        </GiftPixPayment>
      ) : (
        canRetry &&
        onRetry && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={loading}
              onClick={onRetry}
            >
              Consultar pagamento
            </button>
          </div>
        )
      )}
      <PaymentProviderDisclosure />
    </section>
  );
}
