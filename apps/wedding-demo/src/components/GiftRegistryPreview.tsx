import { GiftRegistry } from "@entrelacos/wedding-features";
import { useMemo, useRef, useState } from "react";
import {
  type CheckoutStatus,
  checkoutCreateInputSchema,
  checkoutStatusInputSchema,
  checkoutStatusResponseSchema,
  giftCatalogLimits,
  giftQuoteInputSchema,
  giftQuoteResponseSchema,
  publicGiftCatalogPageResponseSchema,
  publicGiftCatalogQuerySchema,
  publicGiftCatalogResponseSchema,
} from "../../../../packages/contracts/src/index";

export type GiftPreviewScenario =
  | "normal"
  | "catalog-error"
  | "quote-error"
  | "slow-quote"
  | "expiring-quote"
  | "foreign-site"
  | "slow-recovery"
  | "received-history"
  | "refunded-history";

const scenarios: Array<{ value: GiftPreviewScenario; label: string }> = [
  { value: "normal", label: "Fluxo normal" },
  { value: "catalog-error", label: "Erro de catálogo" },
  { value: "quote-error", label: "Erro de cotação" },
  { value: "slow-quote", label: "Cotação lenta" },
  { value: "expiring-quote", label: "Cotação expira em 3 segundos" },
  { value: "foreign-site", label: "Resposta de outro casamento" },
  { value: "slow-recovery", label: "Consulta de pagamento lenta" },
  { value: "received-history", label: "Recebimento seguido de verificação" },
  { value: "refunded-history", label: "Reembolso seguido de verificação" },
];

const recoveryStates: Array<{ value: CheckoutStatus["state"]; label: string }> =
  [
    { value: "RECEIVED", label: "Recebimento fictício" },
    { value: "REFUNDED", label: "Reembolso fictício" },
    { value: "OUTCOME_UNKNOWN", label: "Resultado em verificação" },
    { value: "CLOSED_UNPAID", label: "Encerrado sem recebimento" },
    { value: "AWAITING_PAYMENT", label: "Aguardando pagamento" },
  ];

const PREVIEW_SITE_ID = "local-gift-preview";
const PREVIEW_API_ORIGIN = "https://gift-preview.invalid";
const PREVIEW_PREFIX = `/v1/public/sites/${PREVIEW_SITE_ID}/`;

const catalog = publicGiftCatalogResponseSchema.parse({
  mode: "sandbox",
  gifts: [
    {
      id: "gift-preview-dinner",
      siteId: PREVIEW_SITE_ID,
      title: "Jantar especial para celebrar",
      description:
        "Uma refeição preparada com carinho para marcar um momento especial da viagem.",
      nominalCents: 13_500,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    {
      id: "gift-preview-city-walk",
      siteId: PREVIEW_SITE_ID,
      title: "Um passeio tranquilo a dois pela cidade",
      description:
        "Uma contribuição para descobrir ruas, praças e cafés no ritmo do casal.",
      nominalCents: 8_000,
      currency: "BRL",
      image: null,
      sortOrder: 1,
    },
    {
      id: "gift-preview-weekend",
      siteId: PREVIEW_SITE_ID,
      title:
        "Uma experiência de fim de semana com bastante tempo para descansar",
      description:
        "Um presente simbólico para uma pausa tranquila depois da celebração, com tempo para aproveitar a hospedagem, tomar um café sem pressa e guardar boas lembranças. O valor representa apenas a contribuição escolhida para o casal: não existe produto físico, reserva ou entrega associada a esta prévia local.",
      nominalCents: 24_000,
      currency: "BRL",
      image: null,
      sortOrder: 2,
    },
  ],
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function notFound(): Response {
  return jsonResponse({ code: "NOT_FOUND" }, 404);
}

function validationError(): Response {
  return jsonResponse({ code: "VALIDATION_ERROR" }, 400);
}

function catalogQuery(search: string) {
  const raw = search.slice(1);
  if (new TextEncoder().encode(raw).byteLength > giftCatalogLimits.queryBytes)
    throw new Error("Invalid catalog query");
  const input: { page?: number; q?: string } = {};
  const seen = new Set<string>();
  for (const pair of raw ? raw.split("&") : []) {
    const separator = pair.indexOf("=");
    const key = decodeURIComponent(
      (separator < 0 ? pair : pair.slice(0, separator)).replace(/\+/g, " "),
    );
    const value = separator < 0 ? "" : pair.slice(separator + 1);
    if (!["page", "q"].includes(key) || seen.has(key))
      throw new Error("Invalid catalog query");
    seen.add(key);
    if (key === "page") {
      if (!/^[1-9][0-9]*$/.test(value))
        throw new Error("Invalid catalog query");
      input.page = Number(value);
    } else input.q = decodeURIComponent(value.replace(/\+/g, " "));
  }
  return publicGiftCatalogQuerySchema.parse(input);
}

export function createGiftPreviewFetcher(
  now: () => Date = () => new Date(),
  scenario: GiftPreviewScenario = "normal",
  onCheckoutRequest: () => void = () => {},
  readRecoveryState?: () => CheckoutStatus["state"],
): typeof fetch {
  return async (input, init) => {
    let request: Request;
    let url: URL;
    try {
      request = new Request(input, init);
      url = new URL(request.url);
    } catch {
      return notFound();
    }

    if (
      url.origin !== PREVIEW_API_ORIGIN ||
      url.hash !== "" ||
      !url.pathname.startsWith(PREVIEW_PREFIX)
    ) {
      return notFound();
    }

    const resource = url.pathname.slice(PREVIEW_PREFIX.length);
    if (resource === "gifts" && request.method === "GET") {
      let query: ReturnType<typeof catalogQuery>;
      try {
        query = catalogQuery(url.search);
      } catch {
        return validationError();
      }
      if (scenario === "catalog-error") {
        return jsonResponse({ code: "CATALOG_UNAVAILABLE" }, 503);
      }
      // Fictional server fixture only; this does not model PostgreSQL Unicode case behavior.
      const matching = catalog.gifts.filter(
        (gift) =>
          gift.title.toLowerCase().includes(query.q.toLowerCase()) ||
          gift.description.toLowerCase().includes(query.q.toLowerCase()),
      );
      const total = matching.length;
      const page = publicGiftCatalogPageResponseSchema.parse({
        siteId: PREVIEW_SITE_ID,
        mode: "sandbox",
        ...query,
        pageSize: giftCatalogLimits.pageSize,
        gifts: matching.slice(
          (query.page - 1) * giftCatalogLimits.pageSize,
          query.page * giftCatalogLimits.pageSize,
        ),
        total,
        totalPages: Math.max(1, Math.ceil(total / giftCatalogLimits.pageSize)),
        hasNext:
          query.page <
          Math.max(1, Math.ceil(total / giftCatalogLimits.pageSize)),
      });
      const serialized = JSON.stringify(page);
      if (
        new TextEncoder().encode(serialized).byteLength >
        giftCatalogLimits.jsonBytes
      )
        return jsonResponse({ code: "CATALOG_UNAVAILABLE" }, 503);
      return new Response(serialized, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.search !== "") return notFound();

    if (resource === "gift-quotes" && request.method === "POST") {
      let inputValue: ReturnType<typeof giftQuoteInputSchema.parse>;
      try {
        inputValue = giftQuoteInputSchema.parse(await request.json());
      } catch {
        return validationError();
      }
      if (scenario === "quote-error") {
        return jsonResponse({ code: "PROVIDER_MODE_UNAVAILABLE" }, 503);
      }
      if (scenario === "slow-quote") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const gift = catalog.gifts.find((item) => item.id === inputValue.giftId);
      if (!gift) return jsonResponse({ code: "QUOTE_INVALID" }, 409);

      const commissionCents = Math.round((gift.nominalCents * 200) / 10_000);
      // Fixture-only processing amounts stand in for values from a server quote.
      const processingCents = inputValue.method === "PIX" ? 90 : 290;
      const quote = giftQuoteResponseSchema.parse({
        quote: {
          id: `gift-preview-${gift.id}-${inputValue.method.toLowerCase()}`,
          giftId: gift.id,
          siteId:
            scenario === "foreign-site"
              ? "another-preview-wedding"
              : PREVIEW_SITE_ID,
          title: gift.title,
          method: inputValue.method,
          currency: "BRL",
          nominalCents: gift.nominalCents,
          commissionBasisPoints: 200,
          commissionCents,
          processingCents,
          totalCents: gift.nominalCents,
          feeAllocation: "RECIPIENT_DEDUCTED",
          policyVersion: "local-gift-policy-v1",
          expiresAt: new Date(
            now().getTime() +
              (scenario === "expiring-quote" ? 3_000 : 5 * 60_000),
          ).toISOString(),
          mode: "sandbox",
        },
      });
      return jsonResponse(quote);
    }

    if (resource === "gift-checkouts" && request.method === "POST") {
      try {
        checkoutCreateInputSchema.parse(await request.json());
      } catch {
        return validationError();
      }
      onCheckoutRequest();
      return jsonResponse({ code: "EXTERNAL_OUTCOME_UNKNOWN" }, 409);
    }

    if (resource === "gift-checkouts/status" && request.method === "POST") {
      let inputValue: ReturnType<typeof checkoutStatusInputSchema.parse>;
      try {
        inputValue = checkoutStatusInputSchema.parse(await request.json());
      } catch {
        return validationError();
      }
      if (scenario === "received-history" || scenario === "refunded-history") {
        const method = (["PIX", "CREDIT_CARD"] as const).find((candidate) =>
          catalog.gifts.some(
            (gift) =>
              inputValue.quoteId ===
              `gift-preview-${gift.id}-${candidate.toLowerCase()}`,
          ),
        );
        if (!method) return validationError();
        const state =
          readRecoveryState?.() ??
          (scenario === "received-history" ? "RECEIVED" : "REFUNDED");
        // Fictional observations exercise the consumer's historical floor; no
        // provider, payment record or financial ledger is queried or changed.
        const status = checkoutStatusResponseSchema.safeParse({
          status: {
            siteId: PREVIEW_SITE_ID,
            quoteId: inputValue.quoteId,
            requestId: inputValue.requestId,
            orderId: "gift-preview-order",
            attemptId: "gift-preview-attempt",
            method,
            mode: "sandbox",
            state,
            observedAt: now().toISOString(),
            closedReason: state === "CLOSED_UNPAID" ? "EXPIRED" : null,
            mayStartNewAttempt: state === "CLOSED_UNPAID",
            checkout:
              state === "AWAITING_PAYMENT"
                ? {
                    orderId: "gift-preview-order",
                    attemptId: "gift-preview-attempt",
                    quoteId: inputValue.quoteId,
                    method,
                    mode: "sandbox",
                    hostedUrl: "https://gift-preview.invalid/no-payment",
                  }
                : null,
          },
        });
        return status.success ? jsonResponse(status.data) : validationError();
      }
      if (scenario === "slow-recovery")
        await new Promise((resolve) => setTimeout(resolve, 1500));
      return jsonResponse({ code: "PROVIDER_MODE_UNAVAILABLE" }, 409);
    }

    return notFound();
  };
}

export function GiftRegistryPreview() {
  const [scenario, setScenario] = useState<GiftPreviewScenario>("normal");
  const [checkoutRequests, setCheckoutRequests] = useState(0);
  const [recoveryState, setRecoveryState] =
    useState<CheckoutStatus["state"]>("RECEIVED");
  const recoveryStateRef = useRef(recoveryState);
  recoveryStateRef.current = recoveryState;
  const fetcher = useMemo(
    () =>
      createGiftPreviewFetcher(
        () => new Date(),
        scenario,
        () => setCheckoutRequests((count) => count + 1),
        () => recoveryStateRef.current,
      ),
    [scenario],
  );

  return (
    <section
      className="grid min-w-0 gap-4"
      aria-label="Prévia local dos presentes"
    >
      <p
        className="m-0 border border-template-line bg-template-surface p-4 text-sm text-template-muted"
        role="note"
      >
        Prévia local — dados fictícios, sem pagamentos reais
      </p>
      <div className="grid min-w-0 gap-2">
        <label
          htmlFor="gift-preview-scenario"
          className="text-sm font-medium text-template-ink"
        >
          Cenário da prévia
        </label>
        <select
          id="gift-preview-scenario"
          className="min-h-11 min-w-0 rounded-lg border border-template-line bg-template-surface px-3 py-2 text-template-ink"
          value={scenario}
          onChange={(event) => {
            const next = event.target.value as GiftPreviewScenario;
            setScenario(next);
            setRecoveryState(
              next === "refunded-history" ? "REFUNDED" : "RECEIVED",
            );
          }}
        >
          {scenarios.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {(scenario === "received-history" || scenario === "refunded-history") && (
        <div className="grid min-w-0 gap-2">
          <label
            htmlFor="gift-preview-recovery"
            className="text-sm font-medium text-template-ink"
          >
            Resultado fictício da próxima consulta
          </label>
          <select
            id="gift-preview-recovery"
            className="min-h-11 min-w-0 rounded-lg border border-template-line bg-template-surface px-3 py-2 text-template-ink"
            value={recoveryState}
            onChange={(event) =>
              setRecoveryState(event.target.value as CheckoutStatus["state"])
            }
          >
            {recoveryStates.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="m-0 text-sm text-template-muted">
            Consulte o recebimento ou reembolso fictício primeiro. Depois
            escolha verificação e consulte novamente. Após fechar ou recarregar,
            consulte os resultados de encerramento ou pagamento pendente: a
            operação anterior deve continuar bloqueada.
          </p>
        </div>
      )}
      <p className="m-0 text-sm text-template-muted" role="status">
        Tentativas de checkout nesta prévia: {checkoutRequests}
      </p>
      <GiftRegistry
        key={scenario}
        siteId={PREVIEW_SITE_ID}
        apiOrigin={PREVIEW_API_ORIGIN}
        demo
        fetcher={fetcher}
      />
    </section>
  );
}
