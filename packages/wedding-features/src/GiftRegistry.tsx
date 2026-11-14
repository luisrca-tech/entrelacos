import type {
  CheckoutCreateInput,
  CheckoutStatus,
  GiftQuote,
  PublicGiftCatalogPageResponse,
  PublicGiftItem,
} from "@entrelacos/contracts";
import {
  checkoutCreateInputSchema,
  publicGiftCatalogQuerySchema,
} from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui/toast";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { GiftCatalogView } from "./GiftCatalogView";
import { GiftQuoteView } from "./GiftQuoteView";
import { GiftRecoveryView } from "./GiftRecoveryView";
import { recoverGiftCheckout } from "./giftCheckoutRecovery";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  createGiftCheckoutRecoveryToken,
  loadPendingGiftCheckout,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";
import { submitGiftCheckout } from "./giftCheckoutSubmission";
import {
  getGiftErrorMessage,
  WeddingGiftsApi,
  type WeddingGiftsApiOptions,
} from "./gifts";
import { SiteDialog } from "./SiteDialog";

type Catalog = PublicGiftCatalogPageResponse;
type CatalogOwner = {
  active: boolean;
  controller: AbortController | null;
  pending: (() => void) | null;
};
export type GiftRegistryProps = WeddingGiftsApiOptions;

const fetcherIds = new WeakMap<typeof fetch, number>();
let nextFetcherId = 1;

function fetcherIdentity(fetcher?: typeof fetch): number {
  if (!fetcher) return 0;
  let id = fetcherIds.get(fetcher);
  if (id === undefined) {
    id = nextFetcherId++;
    fetcherIds.set(fetcher, id);
  }
  return id;
}

export function GiftRegistry(props: GiftRegistryProps) {
  return (
    <GiftRegistryCatalogOwner
      runtimeKey={JSON.stringify([
        props.apiOrigin,
        props.siteId,
        props.demo === true,
        props.liveDemoSiteId ?? null,
        fetcherIdentity(props.fetcher),
      ])}
      {...props}
    />
  );
}

function GiftRegistryCatalogOwner({
  runtimeKey,
  ...props
}: GiftRegistryProps & { runtimeKey: string }) {
  const owner = useRef<CatalogOwner>({
    active: false,
    controller: null,
    pending: null,
  });
  return (
    <GiftRegistryRuntime key={runtimeKey} {...props} catalogOwner={owner} />
  );
}

function GiftRegistryRuntime({
  siteId,
  apiOrigin,
  fetcher,
  demo = false,
  liveDemoSiteId,
  catalogOwner,
}: GiftRegistryProps & { catalogOwner: { current: CatalogOwner } }) {
  const api = useMemo(() => {
    try {
      return new WeddingGiftsApi({
        siteId,
        apiOrigin,
        fetcher,
        demo,
        liveDemoSiteId,
      });
    } catch {
      return null;
    }
  }, [siteId, apiOrigin, fetcher, demo, liveDemoSiteId]);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const recoveryInFlight = useRef(false);
  const currentRecoveredStatus = useRef<CheckoutStatus | null>(null);
  const recoveryEpoch = useRef(0);
  const recoveryAction = useRef<() => Promise<string | undefined>>(
    async () => undefined,
  );
  const mounted = useRef(true);
  const activeApi = useRef(api);
  activeApi.current = api;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryEpoch.current++;
    };
  }, []);
  const [catalog, setCatalog] = useState<{
    api: WeddingGiftsApi;
    value: Catalog;
    generation: number;
  } | null>(null);
  const catalogGeneration = useRef(0);
  const catalogFailureNotified = useRef(false);
  const catalogActions = useRef<{
    page: (page: number) => void;
  } | null>(null);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogShown, setCatalogShown] = useState(false);
  const [state, dispatch] = useReducer(
    giftCheckoutReducer,
    undefined,
    createGiftCheckoutState,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const recovering = state.phase === "UNKNOWN";
  const currentCatalog = catalog?.api === api ? catalog.value : null;
  const outcomePending =
    recovering || state.phase === "CREATING" || state.phase === "REDIRECTING";
  const visible =
    (catalogShown && currentCatalog?.mode !== "disabled") ||
    recovering ||
    state.checkoutStatus !== null;

  useEffect(() => {
    const surface = root.current?.closest<HTMLElement>("[data-gift-section]");
    if (surface) surface.hidden = !visible;
    return () => {
      if (surface) surface.hidden = true;
    };
  }, [visible]);

  useEffect(() => {
    try {
      const pending = loadPendingGiftCheckout(
        () => window.sessionStorage,
        siteId,
      );
      if (pending) dispatch({ type: "RESTORE_UNKNOWN", siteId, pending });
    } catch {
      dispatch({ type: "RESTORE_UNKNOWN" });
    }
  }, [siteId]);

  useEffect(() => {
    setCatalog(null);
    dispatch({ type: "CLOSE" });
    setDialogOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    let query = { page: 1, q: "" };
    const owner = catalogOwner.current;
    if (!api) return;
    const invalidate = () => {
      const generation = ++catalogGeneration.current;
      setCatalogLoading(true);
      setCatalogError(false);
      owner.pending = null;
      owner.controller?.abort();
      return generation;
    };
    const intentCurrent = (generation: number) =>
      active &&
      mounted.current &&
      activeApi.current === api &&
      generation === catalogGeneration.current;
    const run = () => {
      if (!active || !mounted.current || activeApi.current !== api) return;
      if (owner.active) {
        owner.pending = run;
        return;
      }
      owner.active = true;
      const controller = new AbortController();
      owner.controller = controller;
      const generation = catalogGeneration.current;
      const requested = { ...query };
      const current = () =>
        active &&
        mounted.current &&
        activeApi.current === api &&
        generation === catalogGeneration.current &&
        !controller.signal.aborted;
      void (async () => {
        try {
          const value = await api.getCatalog(requested, controller.signal);
          if (current()) {
            setCatalog({ api, value, generation });
            if (value.gifts.length && value.mode !== "disabled")
              setCatalogShown(true);
            setCatalogLoading(false);
            setCatalogError(false);
            catalogFailureNotified.current = false;
          }
        } catch {
          if (current()) {
            setCatalogLoading(false);
            setCatalogError(true);
            if (!catalogFailureNotified.current) {
              catalogFailureNotified.current = true;
              toast.error("Não foi possível carregar os presentes agora.");
            }
          }
        } finally {
          owner.active = false;
          owner.controller = null;
          const latest = owner.pending;
          owner.pending = null;
          latest?.();
        }
      })();
    };
    catalogActions.current = {
      page: (page) => {
        if (!active) return;
        const parsed = publicGiftCatalogQuerySchema.safeParse({
          ...query,
          page,
        });
        if (!parsed.success) return;
        const generation = invalidate();
        if (!intentCurrent(generation)) return;
        query = parsed.data;
        setCatalogPage(page);
        run();
      },
    };
    const refresh = () => {
      if (!owner.active) run();
    };
    run();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      catalogGeneration.current++;
      catalogActions.current = null;
      if (owner.pending === run) owner.pending = null;
      owner.controller?.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [api, catalogOwner]);

  useEffect(() => {
    if (!api || !state.gift || !state.method || state.phase !== "QUOTING")
      return;
    let active = true;
    const revision = state.revision;
    void api
      .quoteGift({
        giftId: state.gift.id,
        method: state.method,
        ...(state.method === "CREDIT_CARD" && state.installmentCount > 1
          ? { installmentCount: state.installmentCount }
          : {}),
      })
      .then((quote) => {
        if (active) dispatch({ type: "QUOTE_RESOLVED", quote, revision });
      })
      .catch((error) => {
        if (active)
          dispatch({
            type: "QUOTE_FAILED",
            message: getGiftErrorMessage(error),
            revision,
          });
      });
    return () => {
      active = false;
    };
  }, [
    api,
    state.gift,
    state.method,
    state.installmentCount,
    state.phase,
    state.revision,
  ]);

  useEffect(() => {
    if (state.phase === "REDIRECTING" && state.checkout)
      window.location.assign(state.checkout.hostedUrl);
  }, [state.phase, state.checkout]);

  useEffect(() => {
    const resumeCheckout = (event: PageTransitionEvent) => {
      if (event.persisted) dispatch({ type: "CHECKOUT_RETURNED" });
    };
    window.addEventListener("pageshow", resumeCheckout);
    return () => window.removeEventListener("pageshow", resumeCheckout);
  }, []);

  function chooseGift(gift: PublicGiftItem) {
    if (
      outcomePending ||
      catalogLoading ||
      catalogError ||
      catalog?.generation !== catalogGeneration.current
    )
      return;
    dispatch({ type: "SELECT_GIFT", gift });
    setOperationError("");
    setDialogOpen(true);
  }
  function chooseMethod(
    method: GiftQuote["method"],
    installmentCount?: number,
  ) {
    setOperationError("");
    dispatch({ type: "SELECT_METHOD", method, installmentCount });
  }
  async function recover(manual = false) {
    if (!api || !recovering || !state.pending || recoveryInFlight.current)
      return;
    recoveryInFlight.current = true;
    currentRecoveredStatus.current = null;
    setRecoveryLoading(true);
    if (manual) setRecoveryError(false);
    const requestApi = api;
    const epoch = recoveryEpoch.current;
    const current = () =>
      mounted.current &&
      activeApi.current === requestApi &&
      recoveryEpoch.current === epoch;
    try {
      const event = await recoverGiftCheckout(
        api,
        state,
        () => window.sessionStorage,
        current,
      );
      if (!current()) return;
      if (event?.type === "STATUS_RESOLVED") {
        dispatch(event);
        currentRecoveredStatus.current = event.status;
        setRecoveryError(false);
        return event.status.state;
      }
      setRecoveryError(true);
    } catch {
      if (current()) setRecoveryError(true);
    } finally {
      recoveryInFlight.current = false;
      if (current()) setRecoveryLoading(false);
    }
  }

  function continuePayment(checkout: NonNullable<CheckoutStatus["checkout"]>) {
    const latest = currentRecoveredStatus.current;
    if (
      !mounted.current ||
      recoveryInFlight.current ||
      latest?.state !== "AWAITING_PAYMENT" ||
      latest.checkout?.hostedUrl !== checkout.hostedUrl ||
      latest.quoteId !== checkout.quoteId ||
      latest.orderId !== checkout.orderId ||
      latest.attemptId !== checkout.attemptId ||
      latest.method !== checkout.method ||
      latest.mode !== checkout.mode
    )
      return;
    window.location.assign(checkout.hostedUrl);
  }

  recoveryAction.current = recover;
  const pendingRequestId = state.pending?.requestId;
  useEffect(() => {
    if (state.phase === "UNKNOWN") setDialogOpen(false);
  }, [state.phase]);
  useEffect(() => {
    if (!api || state.phase !== "UNKNOWN" || !pendingRequestId) return;
    let active = true;
    let timer: number | undefined;
    let checks = 0;
    const check = async () => {
      const status = await recoveryAction.current();
      if (!active) return;
      checks++;
      if (
        checks < 10 &&
        !["CONFIRMED", "RECEIVED", "REFUNDED", "CLOSED_UNPAID"].includes(
          status ?? "",
        )
      ) {
        timer = window.setTimeout(() => void check(), 3000);
      }
    };
    const recheck = () => void recoveryAction.current();
    void check();
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [api, state.phase, pendingRequestId]);

  async function checkout(payer?: CheckoutCreateInput["payer"]) {
    if (!api || state.phase !== "READY" || !state.quote || inFlight.current)
      return;
    inFlight.current = true;
    setOperationError("");
    const quote = state.quote;
    const requestApi = api;
    const current = () => mounted.current && activeApi.current === requestApi;
    try {
      const requestId = state.requestId ?? crypto.randomUUID();
      const recoveryToken =
        state.recoveryToken ?? createGiftCheckoutRecoveryToken();
      const event = {
        type: "CHECKOUT_STARTED",
        requestId,
        recoveryToken,
        now: new Date().toISOString(),
      } as const;
      if (giftCheckoutReducer(state, event).phase !== "CREATING") {
        dispatch(event);
        return;
      }
      const pending = {
        quoteId: quote.id,
        requestId,
        recoveryToken,
        method: quote.method,
        mode: quote.mode,
      };
      if (
        ((quote.installmentCount ?? 1) > 1 && !payer) ||
        !checkoutCreateInputSchema.safeParse({
          quoteId: pending.quoteId,
          requestId,
          recoveryToken,
          payer,
        }).success
      ) {
        setOperationError(
          "Confira o nome, o CPF ou CNPJ e o e-mail do pagador.",
        );
        return;
      }
      writePendingGiftCheckout(window.sessionStorage, siteId, pending);
      dispatch(event);
      const result = await submitGiftCheckout(
        api,
        quote,
        pending,
        () => window.sessionStorage,
        current,
        payer,
      );
      if (result && current()) dispatch(result);
    } catch {
      setOperationError(
        "Não foi possível preparar o pagamento com segurança. Tente novamente neste navegador.",
      );
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div ref={root} data-gift-runtime className="grid min-w-0 gap-5">
      {(recovering || state.checkoutStatus) && (
        <GiftRecoveryView
          siteId={siteId}
          status={state.checkoutStatus}
          loading={recoveryLoading}
          error={recovering && (!api || !state.pending || recoveryError)}
          canRetry={recovering && !!api && !!state.pending}
          onRetry={() => void recover(true)}
          onContinue={continuePayment}
        />
      )}
      {currentCatalog && (
        <GiftCatalogView
          recoveryOnly={recovering}
          gifts={currentCatalog.gifts}
          mode={currentCatalog.mode}
          busy={outcomePending || catalogLoading || catalogError}
          onSelect={chooseGift}
          paging={
            catalogShown
              ? {
                  page: catalogPage,
                  total: currentCatalog.total,
                  totalPages: currentCatalog.totalPages,
                  loading: catalogLoading,
                  error: catalogError,
                  onPage: (page) => catalogActions.current?.page(page),
                }
              : undefined
          }
        />
      )}
      <SiteDialog
        open={dialogOpen && !!state.gift && state.phase !== "UNKNOWN"}
        labelledBy="gift-quote-heading"
        className="overflow-hidden p-0 [@media(max-width:760px)]:fixed [@media(max-width:760px)]:inset-0 [@media(max-width:760px)]:m-0 [@media(max-width:760px)]:h-dvh [@media(max-width:760px)]:max-h-dvh [@media(max-width:760px)]:w-full [@media(max-width:760px)]:max-w-none [@media(max-width:760px)]:rounded-none"
        onClose={() => {
          setDialogOpen(false);
          dispatch({ type: "CLOSE" });
        }}
      >
        {(requestClose) =>
          !dialogOpen || state.phase === "UNKNOWN" ? null : (
            <GiftQuoteView
              quote={state.quote}
              method={state.method}
              installmentCount={state.installmentCount}
              loading={state.phase === "QUOTING"}
              pending={
                state.phase === "CREATING" || state.phase === "REDIRECTING"
              }
              error={operationError || state.error || undefined}
              notice={state.notice ?? undefined}
              onSelectMethod={chooseMethod}
              onConfirm={(payer) => void checkout(payer)}
              onCancel={requestClose}
            />
          )
        }
      </SiteDialog>
    </div>
  );
}
