import type {
  GiftQuote,
  PublicGiftCatalogPageResponse,
  PublicGiftItem,
} from "@entrelacos/contracts";
import { publicGiftCatalogQuerySchema } from "@entrelacos/contracts";
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
  hasUnresolvedGiftCheckout,
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
  catalogOwner,
}: GiftRegistryProps & { catalogOwner: { current: CatalogOwner } }) {
  const api = useMemo(() => {
    try {
      return new WeddingGiftsApi({ siteId, apiOrigin, fetcher, demo });
    } catch {
      return null;
    }
  }, [siteId, apiOrigin, fetcher, demo]);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const recoveryInFlight = useRef(false);
  const mounted = useRef(true);
  const activeApi = useRef(api);
  activeApi.current = api;
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [catalog, setCatalog] = useState<{
    api: WeddingGiftsApi;
    value: Catalog;
    generation: number;
  } | null>(null);
  const catalogGeneration = useRef(0);
  const catalogActions = useRef<{
    search: (q: string) => void;
    page: (page: number) => void;
  } | null>(null);
  const [searchText, setSearchText] = useState("");
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
  const currentCatalog = catalog?.api === api ? catalog.value : null;
  const outcomePending =
    state.phase === "UNKNOWN" ||
    state.phase === "CREATING" ||
    state.phase === "REDIRECTING";
  const visible =
    (catalogShown && currentCatalog?.mode !== "disabled") ||
    state.phase === "UNKNOWN" ||
    state.checkoutStatus !== null;

  useEffect(() => {
    const surface = root.current?.closest<HTMLElement>("[data-gift-section]");
    if (surface) surface.hidden = !visible;
    return () => {
      if (surface) surface.hidden = true;
    };
  }, [visible]);

  useEffect(() => {
    if (hasUnresolvedGiftCheckout(() => window.sessionStorage, siteId)) {
      try {
        const pending = loadPendingGiftCheckout(
          () => window.sessionStorage,
          siteId,
        );
        dispatch({
          type: "RESTORE_UNKNOWN",
          siteId,
          pending: pending ?? undefined,
        });
      } catch {
        dispatch({ type: "RESTORE_UNKNOWN" });
      }
    }
  }, [siteId]);

  useEffect(() => {
    setCatalog(null);
    dispatch({ type: "CLOSE" });
    setDialogOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    let debounce: number | undefined;
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
          }
        } catch {
          if (current()) {
            setCatalogLoading(false);
            setCatalogError(true);
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
      search: (q) => {
        if (!active) return;
        const generation = invalidate();
        if (!intentCurrent(generation)) return;
        setSearchText(q);
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          debounce = undefined;
          const parsed = publicGiftCatalogQuerySchema.safeParse({ page: 1, q });
          if (!parsed.success) {
            setCatalogLoading(false);
            setCatalogError(true);
            return;
          }
          query = parsed.data;
          setCatalogPage(1);
          run();
        }, 300);
      },
      page: (page) => {
        if (!active || debounce !== undefined) return;
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
    run();
    const interval = window.setInterval(() => {
      if (owner.active || debounce !== undefined || !active) return;
      const generation = invalidate();
      if (intentCurrent(generation)) run();
    }, 30000);
    return () => {
      active = false;
      catalogGeneration.current++;
      catalogActions.current = null;
      if (owner.pending === run) owner.pending = null;
      owner.controller?.abort();
      window.clearTimeout(debounce);
      window.clearInterval(interval);
    };
  }, [api, catalogOwner]);

  useEffect(() => {
    if (!api || !state.gift || !state.method || state.phase !== "QUOTING")
      return;
    let active = true;
    const revision = state.revision;
    void api
      .quoteGift({ giftId: state.gift.id, method: state.method })
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
  }, [api, state.gift, state.method, state.phase, state.revision]);

  useEffect(() => {
    if (state.phase === "REDIRECTING" && state.checkout)
      window.location.assign(state.checkout.hostedUrl);
  }, [state.phase, state.checkout]);

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
  function chooseMethod(method: GiftQuote["method"]) {
    setOperationError("");
    dispatch({ type: "SELECT_METHOD", method });
  }
  async function recover() {
    if (
      !api ||
      state.phase !== "UNKNOWN" ||
      !state.pending ||
      recoveryInFlight.current
    )
      return;
    recoveryInFlight.current = true;
    setRecoveryLoading(true);
    setRecoveryError(false);
    const requestApi = api;
    const current = () => mounted.current && activeApi.current === requestApi;
    try {
      const event = await recoverGiftCheckout(
        api,
        state,
        () => window.sessionStorage,
        current,
      );
      if (event && current()) dispatch(event);
    } catch {
      if (current()) setRecoveryError(true);
    } finally {
      recoveryInFlight.current = false;
      if (current()) setRecoveryLoading(false);
    }
  }
  async function checkout() {
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
      writePendingGiftCheckout(window.sessionStorage, siteId, pending);
      dispatch(event);
      const result = await submitGiftCheckout(
        api,
        quote,
        pending,
        () => window.sessionStorage,
        current,
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
      {(state.phase === "UNKNOWN" || state.checkoutStatus) && (
        <GiftRecoveryView
          siteId={siteId}
          status={state.checkoutStatus}
          loading={recoveryLoading}
          error={recoveryError}
          canRetry={state.phase === "UNKNOWN" && state.pending !== null}
          onRetry={() => void recover()}
          onContinue={(checkout) => window.location.assign(checkout.hostedUrl)}
        />
      )}
      {state.phase === "UNKNOWN" &&
        (!state.checkoutStatus ||
          ["CREATING", "OUTCOME_UNKNOWN"].includes(
            state.checkoutStatus.state,
          )) && (
          <p
            role="status"
            className="m-0 border border-template-line p-5 text-template-muted"
          >
            Não foi possível confirmar o resultado do pagamento anterior. Não
            inicie outro pagamento enquanto o status estiver pendente. O retorno
            do checkout não confirma o recebimento pelo casal.
          </p>
        )}
      {currentCatalog && (
        <GiftCatalogView
          gifts={
            !catalogLoading &&
            !catalogError &&
            catalog?.generation === catalogGeneration.current
              ? currentCatalog.gifts
              : []
          }
          mode={currentCatalog.mode}
          busy={outcomePending || catalogLoading || catalogError}
          onSelect={chooseGift}
          search={
            catalogShown
              ? {
                  value: searchText,
                  page: catalogPage,
                  total: currentCatalog.total,
                  totalPages: currentCatalog.totalPages,
                  loading: catalogLoading,
                  error: catalogError,
                  onChange: (q) => catalogActions.current?.search(q),
                  onPage: (page) => catalogActions.current?.page(page),
                }
              : undefined
          }
        />
      )}
      <SiteDialog
        open={dialogOpen && !!state.gift}
        labelledBy="gift-quote-heading"
        onClose={() => {
          setDialogOpen(false);
          dispatch({ type: "CLOSE" });
        }}
      >
        {(requestClose) =>
          state.phase === "UNKNOWN" ? (
            <section className="grid gap-4">
              <h2
                id="gift-quote-heading"
                className="font-template-serif text-2xl font-normal"
              >
                Pagamento em verificação
              </h2>
              <p role="status">{state.error}</p>
              <button
                type="button"
                className="min-h-11 cursor-pointer border border-template-ink bg-transparent p-3"
                onClick={requestClose}
              >
                Fechar
              </button>
            </section>
          ) : (
            <GiftQuoteView
              quote={state.quote}
              method={state.method}
              loading={state.phase === "QUOTING"}
              pending={
                state.phase === "CREATING" || state.phase === "REDIRECTING"
              }
              error={operationError || state.error || undefined}
              onSelectMethod={chooseMethod}
              onConfirm={() => void checkout()}
              onCancel={requestClose}
            />
          )
        }
      </SiteDialog>
    </div>
  );
}
