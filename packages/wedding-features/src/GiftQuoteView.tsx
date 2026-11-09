import {
  type CheckoutCreateInput,
  type GiftQuote,
  giftInstallmentExpiryMinutes,
} from "@entrelacos/contracts";
import { AsaasDisclosure, showSandboxNotice } from "@entrelacos/ui";
import { useEffect, useId, useState } from "react";
import { scheduleGiftQuoteExpiry } from "./giftQuoteExpiry";

type PaymentMethod = "PIX" | "CREDIT_CARD";

type Props = {
  quote: GiftQuote | null;
  method: PaymentMethod | null;
  installmentCount?: number;
  loading: boolean;
  pending: boolean;
  error?: string;
  onSelectMethod: (method: PaymentMethod, installmentCount?: number) => void;
  onConfirm: (payer?: CheckoutCreateInput["payer"]) => void;
  onCancel: () => void;
  now?: Date;
};

const primaryButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-3 text-template-ivory font-[inherit] text-sm font-medium transition-[background-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:bg-template-olive hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";
const secondaryButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-line bg-transparent px-5 py-3 text-template-ink font-[inherit] text-sm font-medium transition-[background-color,color,border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-template-ink hover:bg-template-ink hover:text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";
const methodButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-line bg-transparent px-5 py-3 text-template-ink font-[inherit] text-sm font-medium transition-[background-color,color,border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-template-ink hover:bg-template-ink hover:text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none aria-pressed:border-template-ink aria-pressed:bg-template-ink aria-pressed:text-template-ivory";
const fieldClass =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--template-input-line,rgba(37,53,43,0.25))] bg-[var(--template-paper,#fffdf8)] px-4 py-3 text-base text-template-ink font-[inherit] transition-[border-color,box-shadow] duration-200 focus:border-template-olive focus:outline-2 focus:outline-offset-2 focus:outline-template-olive motion-reduce:transition-none";
const quoteCardClass =
  "grid min-w-0 gap-5 rounded-2xl border border-template-line bg-[var(--template-paper,#fffdf8)] p-5 sm:p-6";
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

function hasRoundingAdjustment(amounts: number[]): boolean {
  return amounts.some((cents) => cents !== amounts[0]);
}

export function GiftQuoteView({
  quote,
  method,
  installmentCount = 1,
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
  const payerFormId = useId();
  const roundingHintId = useId();
  const quoteId = quote?.id;
  const expiresAt = quote?.expiresAt;
  useEffect(() => {
    if (now || !quoteId || !expiresAt) return;
    return scheduleGiftQuoteExpiry(expiresAt, () =>
      setExpiredQuote({ id: quoteId, expiresAt }),
    );
  }, [now, quoteId, expiresAt]);
  const quoteMatchesSelection =
    quote !== null &&
    quote.method === method &&
    (quote.installmentCount ?? 1) === installmentCount;
  const quoteIsCurrent =
    quote !== null &&
    new Date(quote.expiresAt).getTime() > (now ?? new Date()).getTime() &&
    !(
      expiredQuote?.id === quote.id &&
      expiredQuote.expiresAt === quote.expiresAt
    );
  const canConfirm =
    quoteMatchesSelection && quoteIsCurrent && !loading && !pending;
  const methodsDisabled = loading || pending;
  const options = method === "CREDIT_CARD" ? quote?.installmentOptions : null;
  const hasRoundedOption = options?.some((option) =>
    hasRoundingAdjustment(option.installmentCents),
  );
  const hasPayerForm = quoteMatchesSelection && installmentCount > 1;
  const installmentAmounts = quoteMatchesSelection
    ? quote.installmentCents
    : null;
  const surcharge = quote?.installmentSurchargeCents ?? 0;

  return (
    <section
      aria-labelledby="gift-quote-heading"
      className="grid max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[minmax(0,1fr)_auto] text-template-ink [@media(max-width:760px)]:h-dvh [@media(max-width:760px)]:max-h-none"
    >
      <div className="grid min-h-0 min-w-0 content-start gap-5 overflow-y-auto overscroll-contain p-[clamp(1.25rem,4vw,2.5rem)]">
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
            Ao confirmar, você continuará em uma página segura de pagamento.
          </p>
        </header>
        <AsaasDisclosure />

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
              Cartão de crédito
            </button>
          </div>
        </fieldset>

        {options && options.length > 1 && (
          <label className="grid min-w-0 gap-2">
            <span className="font-bold">Parcelas</span>
            <select
              className={fieldClass}
              disabled={methodsDisabled}
              aria-describedby={hasRoundedOption ? roundingHintId : undefined}
              value={installmentCount}
              onChange={(event) =>
                onSelectMethod("CREDIT_CARD", Number(event.currentTarget.value))
              }
            >
              {options.map((option) => (
                <option
                  key={option.installmentCount}
                  value={option.installmentCount}
                >
                  {option.installmentCount === 1
                    ? `À vista · ${formatCents(option.totalCents)}`
                    : `${option.installmentCount}x de ${formatCents(option.installmentCents[0])}${hasRoundingAdjustment(option.installmentCents) ? "*" : ""}`}
                </option>
              ))}
            </select>
            {hasRoundedOption && (
              <span id={roundingHintId} className="text-sm text-template-muted">
                * A última parcela tem ajuste de centavos, detalhado no resumo.
              </span>
            )}
          </label>
        )}

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

        {quoteMatchesSelection && (
          <section aria-label="Resumo da cotação" className={quoteCardClass}>
            <dl className="m-0 grid min-w-0 gap-3">
              {installmentAmounts && installmentAmounts.length > 1 && (
                <>
                  <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-template-muted">Valor das parcelas</dt>
                    <dd className="m-0">
                      {installmentAmounts.every(
                        (cents) => cents === installmentAmounts[0],
                      )
                        ? `${installmentAmounts.length}x de ${formatCents(installmentAmounts[0])}`
                        : `${installmentAmounts.length - 1}x de ${formatCents(installmentAmounts[0])} + 1x de ${formatCents(installmentAmounts[installmentAmounts.length - 1])}`}
                    </dd>
                  </div>
                  <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-template-muted">
                      {surcharge < 0
                        ? "Desconto no parcelamento"
                        : "Acréscimo do parcelamento"}
                    </dt>
                    <dd className="m-0">{formatCents(Math.abs(surcharge))}</dd>
                  </div>
                </>
              )}
              <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 border-t border-template-line pt-3 font-bold">
                <dt className="min-w-0">Total a pagar</dt>
                <dd className="m-0 shrink-0">
                  {formatCents(quote.totalCents)}
                </dd>
              </div>
            </dl>
            {quote.feeAllocation !== "RECIPIENT_DEDUCTED" && (
              <p className="m-0 text-sm text-template-muted">
                Taxas incluídas no valor
              </p>
            )}
            {!quoteIsCurrent && (
              <p role="status" className="m-0 text-sm text-template-muted">
                Selecione novamente a forma de pagamento para atualizar os
                valores e continuar.
              </p>
            )}
          </section>
        )}

        {hasPayerForm && (
          <form
            id={payerFormId}
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canConfirm) return;
              const data = new FormData(event.currentTarget);
              onConfirm({
                name: String(data.get("name")).trim(),
                cpfCnpj: String(data.get("cpfCnpj")).replace(/[^0-9]/g, ""),
                email: String(data.get("email")).trim(),
              });
            }}
          >
            <fieldset
              disabled={pending}
              className="grid min-w-0 gap-3 border border-template-line p-4 sm:p-5"
            >
              <legend className="px-1 font-bold">Dados do pagador</legend>
              <p className="m-0 text-sm text-template-muted">
                Estes dados são usados para emitir a cobrança parcelada. Volte a
                esta página para continuar a mesma cobrança ou acompanhar a
                confirmação.
              </p>
              <p className="m-0 text-sm text-template-muted">
                Pague em até {giftInstallmentExpiryMinutes} minutos após a
                emissão. Se o prazo passar, aguarde a confirmação do
                encerramento antes de tentar novamente.
              </p>
              <label className="grid min-w-0 gap-1">
                Nome completo
                <input
                  name="name"
                  autoComplete="name"
                  className={fieldClass}
                  minLength={2}
                  maxLength={100}
                  required
                />
              </label>
              <label className="grid min-w-0 gap-1">
                CPF ou CNPJ
                <input
                  name="cpfCnpj"
                  inputMode="numeric"
                  className={fieldClass}
                  maxLength={18}
                  required
                />
              </label>
              <label className="grid min-w-0 gap-1">
                E-mail
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  className={fieldClass}
                  maxLength={254}
                  required
                />
              </label>
            </fieldset>
          </form>
        )}
      </div>

      <footer className="flex min-w-0 flex-wrap gap-3 border-t border-template-line px-[clamp(1.25rem,4vw,2.5rem)] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type={hasPayerForm ? "submit" : "button"}
          form={hasPayerForm ? payerFormId : undefined}
          className={primaryButtonClass}
          disabled={!canConfirm}
          onClick={hasPayerForm ? undefined : () => onConfirm()}
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
      </footer>
    </section>
  );
}
