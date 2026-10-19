import type { GiftQuote } from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { useEffect, useState } from "react";
import { scheduleGiftQuoteExpiry } from "./giftQuoteExpiry";

type PaymentMethod = "PIX" | "CREDIT_CARD";

type Props = {
  quote: GiftQuote | null;
  method: PaymentMethod | null;
  loading: boolean;
  pending: boolean;
  error?: string;
  onSelectMethod: (method: PaymentMethod) => void;
  onConfirm: () => void;
  onCancel: () => void;
  now?: Date;
};

const primaryButtonClass =
  "min-h-11 cursor-pointer border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "min-h-11 cursor-pointer border border-template-ink bg-transparent px-4 py-[0.65rem] text-template-ink font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const methodButtonClass =
  "min-h-11 cursor-pointer border border-template-ink bg-transparent px-4 py-[0.65rem] text-template-ink font-[inherit] font-bold aria-pressed:bg-template-ink aria-pressed:text-template-ivory disabled:cursor-not-allowed disabled:opacity-50";
const quoteCardClass =
  "grid min-w-0 gap-4 border border-template-line bg-[var(--template-paper,#fffdf8)] p-5 sm:p-6";
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

export function GiftQuoteView({
  quote,
  method,
  loading,
  pending,
  error,
  onSelectMethod,
  onConfirm,
  onCancel,
  now,
}: Props) {
  const [expiredQuote, setExpiredQuote] = useState<Pick<
    GiftQuote,
    "id" | "expiresAt"
  > | null>(null);
  const quoteId = quote?.id;
  const expiresAt = quote?.expiresAt;
  useEffect(() => {
    if (now || !quoteId || !expiresAt) return;
    return scheduleGiftQuoteExpiry(expiresAt, () =>
      setExpiredQuote({ id: quoteId, expiresAt }),
    );
  }, [now, quoteId, expiresAt]);
  const quoteMatchesMethod = quote !== null && quote.method === method;
  const quoteIsCurrent =
    quote !== null &&
    new Date(quote.expiresAt).getTime() > (now ?? new Date()).getTime() &&
    !(
      expiredQuote?.id === quote.id &&
      expiredQuote.expiresAt === quote.expiresAt
    );
  const canConfirm =
    quoteMatchesMethod && quoteIsCurrent && !loading && !pending;
  const methodsDisabled = loading || pending;

  return (
    <section
      aria-labelledby="gift-quote-heading"
      className="grid min-w-0 gap-5 text-template-ink"
    >
      <header className="grid min-w-0 gap-2">
        <h2
          id="gift-quote-heading"
          className="m-0 font-template-serif text-[clamp(1.8rem,5vw,2.6rem)] font-normal leading-tight"
        >
          Contribuição para {quote?.title ?? "o presente"}
        </h2>
        <p className="m-0 text-template-muted">
          Presente simbólico: não há produto físico ou entrega.
        </p>
        <p className="m-0 text-template-muted">
          Ao confirmar, você continuará em uma página segura de pagamento. Esta
          tela não coleta dados de pagamento.
        </p>
      </header>

      {showSandboxNotice(quote?.mode) && (
        <p
          role="status"
          className="m-0 border border-template-line px-4 py-3 text-sm"
        >
          Ambiente de testes — sem pagamentos reais.
        </p>
      )}

      <fieldset className="grid min-w-0 gap-3 border border-template-line p-4 sm:p-5">
        <legend className="px-1 font-bold">Forma de pagamento</legend>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button
            type="button"
            className={methodButtonClass}
            aria-pressed={method === "PIX"}
            disabled={methodsDisabled}
            onClick={() => onSelectMethod("PIX")}
          >
            Pix
          </button>
          <button
            type="button"
            className={methodButtonClass}
            aria-pressed={method === "CREDIT_CARD"}
            disabled={methodsDisabled}
            onClick={() => onSelectMethod("CREDIT_CARD")}
          >
            Cartão à vista
          </button>
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="m-0 border border-template-line p-4">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="m-0 border border-template-line p-4">
          Atualizando a cotação…
        </p>
      )}
      {!quote && !loading && !error && (
        <p role="status" className="m-0 border border-template-line p-4">
          Escolha uma forma de pagamento para consultar a cotação.
        </p>
      )}

      {quote && (
        <section aria-label="Resumo da cotação" className={quoteCardClass}>
          <h3 className="m-0 break-words font-template-serif text-2xl font-normal">
            {quote.title}
          </h3>
          <dl className="m-0 grid min-w-0 gap-3">
            {quote.feeAllocation !== "RECIPIENT_DEDUCTED" && (
              <>
                <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                  <dt className="min-w-0 text-template-muted">
                    Valor do presente
                  </dt>
                  <dd className="m-0 shrink-0">
                    {formatCents(quote.nominalCents + quote.commissionCents)}
                  </dd>
                </div>
                <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                  <dt className="min-w-0 text-template-muted">
                    Taxa de processamento
                  </dt>
                  <dd className="m-0 shrink-0">
                    {formatCents(quote.processingCents)}
                  </dd>
                </div>
              </>
            )}
            <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 border-t border-template-line pt-3 font-bold">
              <dt className="min-w-0">Total a pagar</dt>
              <dd className="m-0 shrink-0">{formatCents(quote.totalCents)}</dd>
            </div>
          </dl>
          <p className="m-0 text-sm text-template-muted">
            Cotação válida até{" "}
            <time dateTime={quote.expiresAt}>
              {dateFormatter.format(new Date(quote.expiresAt))}
            </time>
          </p>
          {!quoteMatchesMethod && (
            <p role="status" className="m-0 text-sm text-template-muted">
              A cotação exibida corresponde a outra forma de pagamento.
            </p>
          )}
          {quoteMatchesMethod && !quoteIsCurrent && (
            <p role="status" className="m-0 text-sm text-template-muted">
              Esta cotação expirou. Atualize a cotação para continuar.
            </p>
          )}
        </section>
      )}

      <div className="flex min-w-0 flex-wrap gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          {pending ? "Aguarde…" : "Continuar para pagamento"}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending}
          onClick={onCancel}
        >
          Voltar
        </button>
      </div>
    </section>
  );
}
