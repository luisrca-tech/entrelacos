import { GIFT_PLATFORM_TARIFFS, type GiftQuote } from "@entrelacos/contracts";
import { PaymentProviderDisclosure, showSandboxNotice } from "@entrelacos/ui";
import { useEffect, useId, useRef, useState } from "react";
import {
  type GiftCheckoutBillingField,
  type GiftCheckoutBillingFields,
  type GiftCheckoutFormInput,
  readGiftCheckoutForm,
} from "./giftCheckoutForm";
import { scheduleGiftQuoteExpiry } from "./giftQuoteExpiry";
import { lookupCep } from "./viaCep";

type PaymentMethod = "PIX" | "CREDIT_CARD";

type Props = {
  quote: GiftQuote | null;
  method: PaymentMethod | null;
  installmentCount?: number;
  loading: boolean;
  pending: boolean;
  error?: string;
  notice?: string;
  onSelectMethod: (method: PaymentMethod, installmentCount?: number) => void;
  onConfirm: (input: GiftCheckoutFormInput) => void;
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
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--template-input-line,rgba(37,53,43,0.25))] bg-[var(--template-paper,#fffdf8)] px-4 py-3 text-base text-template-ink font-[inherit] transition-[border-color,box-shadow] duration-200 focus:border-template-olive focus:outline-2 focus:outline-offset-2 focus:outline-template-olive aria-invalid:border-template-ink aria-invalid:shadow-[inset_0_0_0_1px_var(--color-template-ink)] motion-reduce:transition-none";
const quoteCardClass =
  "grid min-w-0 gap-5 rounded-2xl border border-template-line bg-[var(--template-paper,#fffdf8)] p-5 sm:p-6";
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

const brazilianStates = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
] as const;

const emptyBilling: GiftCheckoutBillingFields = {
  zipCode: "",
  street: "",
  streetNumber: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
};

type CepLookup = "idle" | "loading" | "found" | "not_found" | "unavailable";

const cepLookupMessage: Record<Exclude<CepLookup, "idle">, string> = {
  loading: "Buscando o endereço…",
  found: "Endereço preenchido pelo CEP. Confira e informe o número.",
  not_found: "Não encontramos este CEP. Preencha o endereço.",
  unavailable:
    "Não foi possível buscar o endereço agora. Preencha manualmente.",
};

/** Input names, used to focus the first invalid billing field on submit. */
const billingInputName: Record<GiftCheckoutBillingField, string> = {
  zipCode: "billing-zip",
  street: "billing-street",
  streetNumber: "billing-number",
  complement: "billing-complement",
  neighborhood: "billing-neighborhood",
  city: "billing-city",
  state: "billing-state",
};

/** "01310100" → "01310-100" while typing; keeps at most 8 digits. */
function formatCep(value: string): string {
  const digits = value.replace(/[^0-9]/g, "").slice(0, 8);
  return digits.length > 5
    ? `${digits.slice(0, 5)}-${digits.slice(5)}`
    : digits;
}

const feesTooltip =
  "inclui a taxa do meio de pagamento, a antecipação ao casal (no cartão) e o serviço Entrelaços";

/** "1x à vista · R$ 105,21" or "3x de R$ 36,70 · total R$ 110,10". */
function formatInstallmentOption(amounts: number[], totalCents: number) {
  return amounts.length === 1
    ? `1x à vista · ${formatCents(totalCents)}`
    : `${amounts.length}x de ${formatCents(amounts[0] ?? 0)} · total ${formatCents(totalCents)}`;
}

/** "3x de R$35,33 (última R$35,35)"; the last installment only when it differs. */
function formatInstallmentLabel(amounts: number[]): string {
  const first = amounts[0] ?? 0;
  const last = amounts[amounts.length - 1] ?? first;
  const suffix = last !== first ? ` (última ${formatCents(last)})` : "";
  return `${amounts.length}x de ${formatCents(first)}${suffix}`;
}

export function GiftQuoteView({
  quote,
  method,
  installmentCount = 1,
  loading,
  pending,
  error,
  notice,
  onSelectMethod,
  onConfirm,
  onCancel,
  now,
}: Props) {
  const [expiredQuote, setExpiredQuote] = useState<Pick<
    GiftQuote,
    "id" | "expiresAt"
  > | null>(null);
  const formId = useId();
  const [formError, setFormError] = useState<string | null>(null);
  const cardNumber = useRef<HTMLInputElement>(null);
  const holderName = useRef<HTMLInputElement>(null);
  const expiry = useRef<HTMLInputElement>(null);
  const cvv = useRef<HTMLInputElement>(null);
  const [billing, setBilling] =
    useState<GiftCheckoutBillingFields>(emptyBilling);
  const [cepLookup, setCepLookup] = useState<CepLookup>("idle");
  const [invalidBilling, setInvalidBilling] = useState<
    GiftCheckoutBillingField[]
  >([]);
  // Fields the guest edited since the current CEP lookup started: its answer
  // must not overwrite them.
  const editedDuringLookup = useRef(new Set<GiftCheckoutBillingField>());
  const cepDigits = billing.zipCode.replace(/[^0-9]/g, "");
  const cepStatusId = useId();
  const stateId = useId();
  const quoteId = quote?.id;
  const expiresAt = quote?.expiresAt;
  useEffect(() => {
    if (now || !quoteId || !expiresAt) return;
    return scheduleGiftQuoteExpiry(expiresAt, () =>
      setExpiredQuote({ id: quoteId, expiresAt }),
    );
  }, [now, quoteId, expiresAt]);
  // ViaCEP only saves typing: a failure leaves every field editable.
  useEffect(() => {
    if (cepDigits.length !== 8) {
      setCepLookup("idle");
      return;
    }
    const controller = new AbortController();
    const edited = editedDuringLookup.current;
    edited.clear();
    setCepLookup("loading");
    void lookupCep(cepDigits, fetch, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (typeof found === "string") {
        setCepLookup(found);
        return;
      }
      setCepLookup("found");
      const filled: GiftCheckoutBillingField[] = (
        ["street", "neighborhood", "city", "state"] as const
      ).filter((key) => !edited.has(key) && found[key]);
      setInvalidBilling((previous) =>
        previous.filter((key) => !filled.includes(key)),
      );
      const fill = (key: keyof typeof found, previous: string) =>
        filled.includes(key) ? found[key] : previous;
      setBilling((previous) => ({
        ...previous,
        street: fill("street", previous.street),
        neighborhood: fill("neighborhood", previous.neighborhood),
        city: fill("city", previous.city),
        state: fill("state", previous.state),
      }));
    });
    return () => controller.abort();
  }, [cepDigits]);
  const billingField =
    (key: keyof GiftCheckoutBillingFields) =>
    (event: { currentTarget: { value: string } }) => {
      const value =
        key === "zipCode"
          ? formatCep(event.currentTarget.value)
          : event.currentTarget.value;
      if (key !== "zipCode") editedDuringLookup.current.add(key);
      setInvalidBilling((previous) =>
        previous.includes(key)
          ? previous.filter((field) => field !== key)
          : previous,
      );
      setBilling((previous) => ({ ...previous, [key]: value }));
    };
  const invalid = (key: GiftCheckoutBillingField) =>
    invalidBilling.includes(key) || undefined;
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
  const options =
    method === "CREDIT_CARD"
      ? quote?.installmentOptions?.filter(
          (option) =>
            option.installmentCount <= GIFT_PLATFORM_TARIFFS.maxInstallments,
        )
      : null;
  const withCard = method === "CREDIT_CARD";
  const installmentAmounts = quoteMatchesSelection
    ? quote.installmentCents
    : null;
  const surcharge = quote?.installmentSurchargeCents ?? 0;
  // V2 quotes are always buyer-pays-all: show gift, one fees line and total.
  const showFeeBreakdown = quote?.feeAllocation === "BUYER_GROSS_UP";

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
              Cartão de crédito
            </button>
          </div>
        </fieldset>

        {options && options.length > 0 && (
          <label className="grid min-w-0 gap-2">
            <span className="font-bold">Parcelas</span>
            <select
              className={fieldClass}
              disabled={methodsDisabled}
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
                  {formatInstallmentOption(
                    option.installmentCents,
                    option.totalCents,
                  )}
                </option>
              ))}
            </select>
          </label>
        )}

        {(formError || error) && (
          <p role="alert" className="m-0 border border-template-line p-4">
            {formError || error}
          </p>
        )}
        {notice && !error && !formError && (
          <p role="status" className="m-0 border border-template-line p-4">
            {notice}
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
              {showFeeBreakdown && (
                <>
                  <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-template-muted">Presente</dt>
                    <dd className="m-0">{formatCents(quote.nominalCents)}</dd>
                  </div>
                  <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-template-muted">
                      Taxas e serviço{" "}
                      <button
                        type="button"
                        aria-label={feesTooltip}
                        title={feesTooltip}
                        className="cursor-help rounded-full border border-template-line px-1.5 text-xs"
                      >
                        i
                      </button>
                    </dt>
                    <dd className="m-0">
                      {formatCents(quote.totalCents - quote.nominalCents)}
                    </dd>
                  </div>
                </>
              )}
              {installmentAmounts && installmentAmounts.length > 1 && (
                <>
                  <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-template-muted">Valor das parcelas</dt>
                    <dd className="m-0">
                      {formatInstallmentLabel(installmentAmounts)}
                    </dd>
                  </div>
                  {!showFeeBreakdown && (
                    <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
                      <dt className="text-template-muted">
                        {surcharge < 0
                          ? "Desconto no parcelamento"
                          : "Acréscimo do parcelamento"}
                      </dt>
                      <dd className="m-0">
                        {formatCents(Math.abs(surcharge))}
                      </dd>
                    </div>
                  )}
                </>
              )}
              <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 border-t border-template-line pt-3 font-bold">
                <dt className="min-w-0">Total a pagar</dt>
                <dd className="m-0 shrink-0">
                  {formatCents(quote.totalCents)}
                </dd>
              </div>
            </dl>
            {quote.feeAllocation !== "RECIPIENT_DEDUCTED" &&
              !showFeeBreakdown && (
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

        {method && (
          <form
            id={formId}
            className="grid min-w-0 gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!canConfirm) return;
              const data = new FormData(event.currentTarget);
              const result = readGiftCheckoutForm(
                {
                  name: String(data.get("name") ?? ""),
                  cpf: String(data.get("cpf") ?? ""),
                  email: String(data.get("email") ?? ""),
                  phone: String(data.get("phone") ?? ""),
                  cardNumber: cardNumber.current?.value,
                  holderName: holderName.current?.value,
                  expiry: expiry.current?.value,
                  cvv: cvv.current?.value,
                  billing,
                },
                withCard,
                now ?? new Date(),
              );
              if ("error" in result) {
                setFormError(result.error);
                const fields = result.invalidBilling ?? [];
                setInvalidBilling(fields);
                const first = fields[0] && billingInputName[fields[0]];
                const target = first
                  ? event.currentTarget.elements.namedItem(first)
                  : null;
                if (target instanceof HTMLElement) target.focus();
                return;
              }
              setFormError(null);
              setInvalidBilling([]);
              onConfirm(result.input);
            }}
          >
            <fieldset
              disabled={pending}
              className="grid min-w-0 gap-3 border border-template-line p-4 sm:p-5"
            >
              <legend className="px-1 font-bold">Seus dados</legend>
              <p className="m-0 text-sm text-template-muted">
                {withCard
                  ? "Usados pela Pagar.me para identificar a compra."
                  : "Usados pela Pagar.me para emitir o Pix."}
              </p>
              <label className="grid min-w-0 gap-1">
                Nome completo
                <input
                  name="name"
                  autoComplete="name"
                  className={fieldClass}
                  maxLength={64}
                  required
                />
              </label>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1">
                  CPF
                  <input
                    name="cpf"
                    inputMode="numeric"
                    className={fieldClass}
                    maxLength={14}
                    required
                  />
                </label>
                <label className="grid min-w-0 gap-1">
                  Celular
                  <input
                    name="phone"
                    type="tel"
                    autoComplete="tel-national"
                    placeholder="(11) 98765-4321"
                    className={fieldClass}
                    maxLength={20}
                    required
                  />
                </label>
              </div>
              <label className="grid min-w-0 gap-1">
                E-mail
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  className={fieldClass}
                  maxLength={64}
                  required
                />
              </label>
            </fieldset>
            {withCard && (
              <fieldset
                disabled={pending}
                className="grid min-w-0 gap-3 border border-template-line p-4 sm:p-5"
              >
                <legend className="px-1 font-bold">Cartão de crédito</legend>
                <p className="m-0 text-sm text-template-muted">
                  O cartão vai direto para a Pagar.me. O Entrelaços não recebe
                  nem guarda esses dados.
                </p>
                {/* No name attributes: card data never enters form serialization. */}
                <label className="grid min-w-0 gap-1">
                  Número do cartão
                  <input
                    ref={cardNumber}
                    inputMode="numeric"
                    autoComplete="cc-number"
                    className={fieldClass}
                    maxLength={23}
                    required
                  />
                </label>
                <label className="grid min-w-0 gap-1">
                  Nome impresso no cartão
                  <input
                    ref={holderName}
                    autoComplete="cc-name"
                    className={fieldClass}
                    maxLength={64}
                    required
                  />
                </label>
                <div className="grid min-w-0 grid-cols-2 gap-3">
                  <label className="grid min-w-0 gap-1">
                    Validade
                    <input
                      ref={expiry}
                      inputMode="numeric"
                      autoComplete="cc-exp"
                      placeholder="MM/AA"
                      className={fieldClass}
                      maxLength={7}
                      required
                    />
                  </label>
                  <label className="grid min-w-0 gap-1">
                    CVV
                    <input
                      ref={cvv}
                      inputMode="numeric"
                      autoComplete="cc-csc"
                      className={fieldClass}
                      maxLength={4}
                      required
                    />
                  </label>
                </div>
              </fieldset>
            )}
            {withCard && (
              <fieldset
                disabled={pending}
                className="grid min-w-0 gap-3 border border-template-line p-4 sm:p-5"
              >
                <legend className="px-1 font-bold">Endereço de cobrança</legend>
                <p className="m-0 text-sm text-template-muted">
                  O endereço da fatura do cartão, enviado à Pagar.me com o
                  pagamento. O CEP é consultado no ViaCEP para preencher o
                  restante.
                </p>
                <div className="grid min-w-0 gap-1">
                  <label className="grid min-w-0 gap-1">
                    CEP
                    <input
                      name="billing-zip"
                      inputMode="numeric"
                      autoComplete="billing postal-code"
                      placeholder="00000-000"
                      className={fieldClass}
                      value={billing.zipCode}
                      onChange={billingField("zipCode")}
                      aria-describedby={cepStatusId}
                      aria-invalid={invalid("zipCode")}
                      required
                    />
                  </label>
                  <p
                    id={cepStatusId}
                    role="status"
                    className="m-0 min-h-5 text-sm text-template-muted"
                  >
                    {cepLookup === "idle" ? "" : cepLookupMessage[cepLookup]}
                  </p>
                </div>
                <label className="grid min-w-0 gap-1">
                  Rua
                  <input
                    name="billing-street"
                    autoComplete="billing address-line1"
                    className={fieldClass}
                    maxLength={128}
                    value={billing.street}
                    onChange={billingField("street")}
                    aria-invalid={invalid("street")}
                    required
                  />
                </label>
                <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-end gap-3">
                  <label className="grid min-w-0 gap-1">
                    Número
                    <input
                      name="billing-number"
                      className={fieldClass}
                      maxLength={16}
                      value={billing.streetNumber}
                      onChange={billingField("streetNumber")}
                      aria-invalid={invalid("streetNumber")}
                      required
                    />
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span>
                      Complemento{" "}
                      <span className="text-template-muted">(opcional)</span>
                    </span>
                    <input
                      name="billing-complement"
                      autoComplete="billing address-line2"
                      className={fieldClass}
                      maxLength={64}
                      value={billing.complement}
                      onChange={billingField("complement")}
                      aria-invalid={invalid("complement")}
                    />
                  </label>
                </div>
                <label className="grid min-w-0 gap-1">
                  Bairro
                  <input
                    name="billing-neighborhood"
                    autoComplete="billing address-level3"
                    className={fieldClass}
                    maxLength={64}
                    value={billing.neighborhood}
                    onChange={billingField("neighborhood")}
                    aria-invalid={invalid("neighborhood")}
                    required
                  />
                </label>
                <div className="grid min-w-0 grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-3">
                  <label className="grid min-w-0 gap-1">
                    Cidade
                    <input
                      name="billing-city"
                      autoComplete="billing address-level2"
                      className={fieldClass}
                      maxLength={64}
                      value={billing.city}
                      onChange={billingField("city")}
                      aria-invalid={invalid("city")}
                      required
                    />
                  </label>
                  <div className="grid min-w-0 gap-1">
                    <label htmlFor={stateId}>UF</label>
                    <select
                      id={stateId}
                      name="billing-state"
                      autoComplete="billing address-level1"
                      className={fieldClass}
                      value={billing.state}
                      onChange={billingField("state")}
                      aria-invalid={invalid("state")}
                      required
                    >
                      <option value="">—</option>
                      {brazilianStates.map((state) => (
                        <option key={state} value={state}>
                          {state}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </fieldset>
            )}
          </form>
        )}

        <PaymentProviderDisclosure />
      </div>

      <footer className="flex min-w-0 flex-wrap gap-3 border-t border-template-line px-[clamp(1.25rem,4vw,2.5rem)] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="submit"
          form={method ? formId : undefined}
          className={primaryButtonClass}
          disabled={!canConfirm || !method}
        >
          {pending
            ? "Aguarde…"
            : withCard
              ? quoteMatchesSelection
                ? `Pagar ${formatCents(quote.totalCents)}`
                : "Pagar com cartão"
              : "Gerar Pix"}
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
