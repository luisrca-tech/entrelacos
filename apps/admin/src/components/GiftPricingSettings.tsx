import { Button } from "@entrelacos/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

export type FeeAllocation = "RECIPIENT_DEDUCTED" | "BUYER_GROSS_UP";
const allocation = z.enum(["RECIPIENT_DEDUCTED", "BUYER_GROSS_UP"]);
const settingsSchema = z.object({
  siteId: z.string(),
  feeAllocation: allocation,
  revision: z.number().int().nonnegative(),
  buyerGrossUpAvailable: z.literal(false),
  sandboxBuyerGrossUpAvailable: z.literal(true).optional(),
  blockedReason: z.string().min(1),
});
export type PricingSettings = z.infer<typeof settingsSchema>;
export function parsePricingSettings(
  value: unknown,
  siteId: string,
): PricingSettings {
  const parsed = z.object({ settings: settingsSchema }).parse(value).settings;
  if (parsed.siteId !== siteId) throw new Error("Pricing site changed");
  return parsed;
}
const cents = z.number().int().nonnegative().safe();
const previewSchema = z.object({
  siteId: z.string(),
  feeAllocation: allocation,
  guaranteed: z.literal(false),
  methods: z
    .array(
      z.object({
        method: z.enum(["PIX", "CREDIT_CARD"]),
        available: z.boolean(),
        nominalCents: cents,
        commissionCents: cents,
        processingCents: cents.nullable(),
        totalCents: cents.nullable(),
        recipientNetCents: cents.nullable(),
      }),
    )
    .length(2),
});
export function parsePricingPreview(
  value: unknown,
  siteId: string,
  nominalCents: number,
  feeAllocation: FeeAllocation,
) {
  const parsed = previewSchema.parse(value);
  if (
    parsed.siteId !== siteId ||
    parsed.feeAllocation !== feeAllocation ||
    new Set(parsed.methods.map((m) => m.method)).size !== 2 ||
    parsed.methods.some(
      (m) =>
        m.nominalCents !== nominalCents ||
        (!m.available &&
          (m.processingCents !== null ||
            m.totalCents !== null ||
            m.recipientNetCents !== null)),
    )
  )
    throw new Error("Invalid pricing preview");
  return parsed;
}
type Request = (
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<unknown>;
const PricingContext = createContext<{
  hidden?: boolean;
  settings: PricingSettings | null;
  request: Request;
  siteId: string;
  isCurrent: () => boolean;
} | null>(null);
export const money = (value: number | null) =>
  value === null
    ? "Indisponível"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(value / 100);
export function useGiftFeeAllocation() {
  const context = useContext(PricingContext);
  return context
    ? (context.settings?.feeAllocation ?? null)
    : "RECIPIENT_DEDUCTED";
}
export function GiftPricingSettings({
  enabled = true,
  siteId,
  request,
  isCurrent,
  gifts,
  children,
}: {
  enabled?: boolean;
  siteId: string;
  request: Request;
  isCurrent: () => boolean;
  gifts: { nominalCents: number }[];
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [pending, setPending] = useState<FeeAllocation | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const endpoint = `/v1/sites/${encodeURIComponent(siteId)}/gift-pricing-settings`;
  useEffect(() => {
    if (!enabled) return;
    void retry;
    mounted.current = true;
    const abort = new AbortController();
    setBusy(true);
    setSettings(null);
    setError("");
    void request(endpoint, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && isCurrent())
          setSettings(parsePricingSettings(value, siteId));
      })
      .catch(() => {
        if (!abort.signal.aborted && isCurrent())
          setError(
            "Não foi possível carregar as taxas. Simulações indisponíveis.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted && isCurrent()) setBusy(false);
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [enabled, endpoint, request, isCurrent, retry, siteId]);
  async function save() {
    if (!settings || !pending || busy || !isCurrent()) return;
    setBusy(true);
    setError("");
    try {
      const value = await request(endpoint, {
        method: "PATCH",
        body: { feeAllocation: pending, revision: settings.revision },
      });
      if (mounted.current && isCurrent()) {
        setSettings(parsePricingSettings(value, siteId));
        setPending(null);
      }
    } catch {
      if (mounted.current && isCurrent()) {
        setSettings(null);
        setPending(null);
        setError(
          "Não foi possível confirmar a preferência. Atualize antes de tentar novamente.",
        );
      }
    } finally {
      if (mounted.current && isCurrent()) setBusy(false);
    }
  }
  const values = gifts.map((g) => g.nominalCents);
  const contextValue = useMemo(
    () => ({
      settings: busy || error ? null : settings,
      request,
      siteId,
      isCurrent,
    }),
    [settings, busy, error, request, siteId, isCurrent],
  );
  if (!enabled)
    return (
      <PricingContext.Provider value={{ ...contextValue, hidden: true }}>
        {children}
      </PricingContext.Provider>
    );
  return (
    <PricingContext.Provider value={contextValue}>
      <section
        className="mb-6 space-y-4 rounded-xl border border-admin-line bg-white p-5"
        aria-label="Taxas dos presentes"
        aria-busy={busy}
      >
        <h3 className="font-semibold">Quem será responsável pelas taxas?</h3>
        <p className="text-sm">
          Esta preferência vale para todos os presentes do site. Quando o casal
          assume as taxas, o convidado paga o valor cadastrado. Ao escolher o
          convidado,{" "}
          {settings?.sandboxBuyerGrossUpAvailable
            ? "a homologação fica disponível somente no Sandbox, sem garantia de líquido."
            : "novos pagamentos ficam pausados até a validação das tarifas e da política de diferenças."}
        </p>
        {busy && <p role="status">Carregando ou salvando preferência…</p>}
        {error && (
          <p role="alert">
            {error}{" "}
            <Button
              type="button"
              disabled={busy}
              onClick={() => setRetry((v) => v + 1)}
            >
              Tentar novamente
            </Button>
          </p>
        )}
        <fieldset
          disabled={busy || !settings || Boolean(error)}
          className="space-y-3"
        >
          <legend className="sr-only">Responsável pelas taxas</legend>
          {(
            [
              [
                "RECIPIENT_DEDUCTED",
                "Nós, o casal — taxas descontadas do recebimento",
              ],
              [
                "BUYER_GROSS_UP",
                "O convidado — taxas acrescentadas ao pagamento",
              ],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="gift-fee-allocation"
                checked={(pending ?? settings?.feeAllocation) === mode}
                onChange={() =>
                  setPending(mode === settings?.feeAllocation ? null : mode)
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        {settings?.feeAllocation === "BUYER_GROSS_UP" && (
          <p role="status" className="text-sm">
            {settings.sandboxBuyerGrossUpAvailable
              ? "Homologação Sandbox disponível. Não representa liberação comercial nem garantia de líquido."
              : "Novos pagamentos pausados até a validação das tarifas e da política de diferenças."}
          </p>
        )}
        {pending && (
          <section
            className="space-y-3 rounded-lg border border-admin-line p-4"
            aria-label="Confirmar impacto das taxas"
          >
            <p>
              Alteração em todos os presentes.{" "}
              {values.length
                ? `Valores cadastrados: ${money(Math.min(...values))}${Math.min(...values) !== Math.max(...values) ? ` a ${money(Math.max(...values))}` : ""}.`
                : "Ainda não há presentes cadastrados."}
            </p>
            <p>
              {pending === "BUYER_GROSS_UP"
                ? "Os valores cadastrados passam a representar o líquido pretendido do casal, sem garantia. Confira abaixo os totais estimados para o convidado."
                : "Os valores cadastrados passam a representar exatamente o total que o convidado pagará. O líquido do casal é estimado e depende das tarifas."}{" "}
              {pending === "BUYER_GROSS_UP"
                ? settings?.sandboxBuyerGrossUpAvailable
                  ? "Esta escolha permite somente testes no Sandbox. Divergências de recebimento continuam em conciliação, sem ajuste automático."
                  : "Esta escolha pausa novos pagamentos até a validação das tarifas e da política de diferenças."
                : "Esta escolha mantém os pagamentos pelo valor nominal, com as taxas descontadas do casal."}
            </p>
            {[
              ...new Set(
                values.length ? [Math.min(...values), Math.max(...values)] : [],
              ),
            ].map((nominalCents) => (
              <GiftPricingPreview
                key={`${pending}:${nominalCents}`}
                nominalCents={nominalCents}
                feeAllocation={pending}
              />
            ))}
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {pending === "BUYER_GROSS_UP"
                ? settings?.sandboxBuyerGrossUpAvailable
                  ? "Confirmar homologação Sandbox"
                  : "Confirmar e pausar novos pagamentos"
                : "Confirmar preferência"}
            </Button>{" "}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancelar
            </Button>
          </section>
        )}
      </section>
      {children}
    </PricingContext.Provider>
  );
}
export function GiftPricingPreview({
  nominalCents,
  feeAllocation: requestedFeeAllocation,
}: {
  nominalCents: number | null;
  feeAllocation?: FeeAllocation;
}) {
  const context = useContext(PricingContext);
  const feeAllocation =
    requestedFeeAllocation ?? context?.settings?.feeAllocation;
  const [preview, setPreview] = useState<{
    key: string;
    value: z.infer<typeof previewSchema>;
  } | null>(null);
  const key = JSON.stringify([
    context?.siteId,
    context?.settings?.revision,
    feeAllocation,
    nominalCents,
  ]);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(null);
    if (
      !context?.settings ||
      !feeAllocation ||
      nominalCents === null ||
      !context.isCurrent()
    )
      return;
    const { request, siteId, isCurrent } = context;
    void request(
      `/v1/sites/${encodeURIComponent(siteId)}/gift-pricing-preview`,
      {
        method: "POST",
        signal: abort.signal,
        body: { nominalCents, feeAllocation },
      },
    )
      .then((value) => {
        const parsed = parsePricingPreview(
          value,
          siteId,
          nominalCents,
          feeAllocation,
        );
        if (!abort.signal.aborted && isCurrent())
          setPreview({ key, value: parsed });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [key, context, nominalCents, feeAllocation]);
  if (context?.hidden) return null;
  const current =
    context?.settings && context.isCurrent() && preview?.key === key
      ? preview.value
      : null;
  return (
    <div
      aria-live="polite"
      className="space-y-3 rounded-lg border border-admin-line p-3 text-sm"
    >
      <p>
        Simulação estimada, sem garantia.{" "}
        {feeAllocation === "BUYER_GROSS_UP"
          ? context?.settings?.sandboxBuyerGrossUpAvailable
            ? "Homologação Sandbox. Franquias gratuitas não são prometidas; o líquido efetivo será conferido no recebimento."
            : "Novos pagamentos pausados até a validação das tarifas e da política de diferenças."
          : "O convidado paga o valor cadastrado. O líquido do casal depende das tarifas de pagamento."}
      </p>
      {nominalCents === null ? (
        <p>Informe um valor válido para simular.</p>
      ) : (
        (["PIX", "CREDIT_CARD"] as const).map((method) => {
          const item = current?.methods.find((m) => m.method === method);
          return (
            <section
              key={method}
              aria-label={method === "PIX" ? "Pix" : "Cartão à vista"}
            >
              <h4 className="font-semibold">
                {method === "PIX" ? "Pix" : "Cartão à vista"}
              </h4>
              <dl>
                {[
                  ["Valor cadastrado", nominalCents],
                  ["Comissão Entrelacos (2%)", item?.commissionCents ?? null],
                  ["Processamento Asaas", item?.processingCents ?? null],
                  [
                    "Total do convidado",
                    feeAllocation === "RECIPIENT_DEDUCTED"
                      ? nominalCents
                      : (item?.totalCents ?? null),
                  ],
                  ["Líquido do casal", item?.recipientNetCents ?? null],
                ].map(([label, value]) => (
                  <div
                    className="flex flex-wrap justify-between gap-2"
                    key={label as string}
                  >
                    <dt>{label}</dt>
                    <dd>{money(value as number | null)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })
      )}
    </div>
  );
}
