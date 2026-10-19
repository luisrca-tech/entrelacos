import {
  type CheckoutResult,
  type CheckoutStatus,
  type CheckoutStatusInput,
  checkoutCreateInputSchema,
  checkoutResponseSchema,
  checkoutStatusInputSchema,
  checkoutStatusResponseSchema,
  type GiftQuote,
  giftQuoteInputSchema,
  giftQuoteResponseSchema,
  originSchema,
  type PublicGiftCatalogQuery,
  publicGiftCatalogPageResponseSchema,
  publicGiftCatalogQuerySchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export type WeddingGiftsApiOptions = {
  apiOrigin: string;
  siteId: string;
  fetcher?: typeof fetch;
  demo?: boolean;
};

export class WeddingGiftsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "WeddingGiftsApiError";
  }
}

export class WeddingGiftsApi {
  private readonly apiOrigin: string;
  private readonly siteId: string;
  private readonly fetcher: typeof fetch;
  private readonly demo: boolean;
  constructor({
    apiOrigin,
    siteId,
    fetcher = fetch,
    demo = false,
  }: WeddingGiftsApiOptions) {
    this.apiOrigin = originSchema.parse(apiOrigin);
    this.siteId = siteIdSchema.parse(siteId);
    this.fetcher = (input, init) => fetcher(input, init);
    this.demo = demo;
  }
  private enforceDemoMode(mode: string) {
    if (this.demo && mode === "live")
      throw new WeddingGiftsApiError(502, "LIVE_DEMO_FORBIDDEN");
  }
  async getCatalog(
    input: typeof publicGiftCatalogQuerySchema._input = {},
    signal?: AbortSignal,
  ) {
    const query = publicGiftCatalogQuerySchema.parse(input);
    return this.request(
      "gifts",
      undefined,
      (value) => {
        const result = publicGiftCatalogPageResponseSchema.parse(value);
        this.enforceDemoMode(result.mode);
        if (
          result.siteId !== this.siteId ||
          result.page !== query.page ||
          result.q !== query.q ||
          result.gifts.some((gift) => gift.siteId !== this.siteId) ||
          (result.mode === "disabled" && result.gifts.length > 0)
        )
          throw new Error("Unexpected catalog eligibility");
        return result;
      },
      { query, signal },
    );
  }
  async quoteGift(
    input: typeof giftQuoteInputSchema._input,
  ): Promise<GiftQuote> {
    const body = giftQuoteInputSchema.parse(input);
    return this.request("gift-quotes", body, (value) => {
      const { quote } = giftQuoteResponseSchema.parse(value);
      this.enforceDemoMode(quote.mode);
      if (
        quote.mode === "disabled" ||
        quote.siteId !== this.siteId ||
        quote.giftId !== body.giftId ||
        quote.method !== body.method
      )
        throw new Error("Unexpected quote binding");
      return quote;
    });
  }
  async createCheckout(
    input: typeof checkoutCreateInputSchema._input,
    expected: Pick<GiftQuote, "id" | "siteId" | "method" | "mode">,
  ): Promise<CheckoutResult> {
    const body = checkoutCreateInputSchema.parse(input);
    this.enforceDemoMode(expected.mode);
    if (
      expected.siteId !== this.siteId ||
      body.quoteId !== expected.id ||
      expected.mode === "disabled"
    )
      throw new Error("Unexpected checkout quote");
    return this.request("gift-checkouts", body, (value) => {
      const { checkout } = checkoutResponseSchema.parse(value);
      this.enforceDemoMode(checkout.mode);
      if (
        checkout.quoteId !== expected.id ||
        checkout.method !== expected.method ||
        checkout.mode !== expected.mode
      )
        throw new Error("Unexpected checkout binding");
      return checkout;
    });
  }
  async getCheckoutStatus(
    input: CheckoutStatusInput,
    expected: Pick<GiftQuote, "method" | "mode"> &
      Partial<Pick<CheckoutResult, "orderId" | "attemptId">>,
  ): Promise<CheckoutStatus> {
    const body = checkoutStatusInputSchema.parse(input);
    this.enforceDemoMode(expected.mode);
    if (expected.mode === "disabled")
      throw new Error("Disabled checkout recovery");
    return this.request("gift-checkouts/status", body, (value) => {
      const { status } = checkoutStatusResponseSchema.parse(value);
      this.enforceDemoMode(status.mode);
      if (
        status.siteId !== this.siteId ||
        status.quoteId !== body.quoteId ||
        status.requestId !== body.requestId ||
        status.method !== expected.method ||
        status.mode !== expected.mode ||
        (expected.orderId !== undefined &&
          status.orderId !== expected.orderId) ||
        (expected.attemptId !== undefined &&
          status.attemptId !== expected.attemptId)
      )
        throw new Error("Unexpected recovery binding");
      return status;
    });
  }
  private async readCatalogValue(
    response: Response,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let body: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let eof = false;
    let aborted = signal?.aborted === true;
    let cancellationRequested = false;
    let cancellation: Promise<void> | undefined;
    const requestCancellation = () => {
      if (!body || eof || cancellationRequested) return;
      cancellationRequested = true;
      const target = reader ?? body;
      // Both native operation identity and fulfillment must certify cleanup.
      cancellation = new Promise<void>((resolve) => {
        try {
          const nativeCancel = reader
            ? ReadableStreamDefaultReader.prototype.cancel
            : ReadableStream.prototype.cancel;
          const cancel = target.cancel;
          const genuineOperation = cancel === nativeCancel;
          Promise.prototype.then.call(
            Reflect.apply(cancel, target, []),
            () => {
              if (genuineOperation) resolve();
            },
            () => {},
          );
        } catch {}
      });
    };
    const onAbort = () => {
      aborted = true;
      requestCancellation();
    };
    try {
      signal?.addEventListener("abort", onAbort);
      body = response.body;
      if (!body) throw new Error("Catalog body unavailable");
      if (aborted) throw new Error("Catalog read aborted");
      const getReader = body.getReader;
      if (getReader !== ReadableStream.prototype.getReader)
        throw new Error("Catalog reader acquisition unavailable");
      if (aborted) throw new Error("Catalog read aborted");
      reader = Reflect.apply(
        getReader,
        body,
        [],
      ) as ReadableStreamDefaultReader<Uint8Array>;
      const bytes = new Uint8Array(524288);
      let size = 0,
        chunks = 0;
      while (true) {
        if (aborted) throw new Error("Catalog read aborted");
        const read = reader.read;
        if (read !== ReadableStreamDefaultReader.prototype.read)
          throw new Error("Catalog read operation unavailable");
        if (aborted) throw new Error("Catalog read aborted");
        const startedRead = Reflect.apply(read, reader, []);
        pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            Promise.prototype.then.call(startedRead, resolve, reject);
          },
        );
        const { done, value } = await pendingRead;
        if (aborted) throw new Error("Catalog read aborted");
        if (done) {
          eof = true;
          break;
        }
        if (
          !(value instanceof Uint8Array) ||
          ++chunks > 4096 ||
          size + value.byteLength > bytes.byteLength
        )
          throw new Error("Catalog body exceeds admission");
        bytes.set(value, size);
        size += value.byteLength;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new WeddingGiftsApiError(502, "INVALID_API_RESPONSE");
    } finally {
      if (body && !eof) {
        requestCancellation();
        if (pendingRead) await Promise.allSettled([pendingRead, cancellation]);
        else await cancellation;
      }
      signal?.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
  }
  private async request<T>(
    resource: string,
    body: unknown | undefined,
    parse: (value: unknown) => T,
    catalog?: { query: PublicGiftCatalogQuery; signal?: AbortSignal },
  ): Promise<T> {
    let response: Response;
    if (catalog?.signal?.aborted)
      throw new WeddingGiftsApiError(0, "NETWORK_ERROR");
    const parameters = new URLSearchParams();
    if (catalog && catalog.query.page !== 1)
      parameters.set("page", String(catalog.query.page));
    if (catalog?.query.q) parameters.set("q", catalog.query.q);
    const search = parameters.size ? `?${parameters.toString()}` : "";
    try {
      response = await this.fetcher(
        `${this.apiOrigin}/v1/public/sites/${encodeURIComponent(this.siteId)}/${resource}${search}`,
        {
          method: body === undefined ? "GET" : "POST",
          credentials: "omit",
          cache: "no-store",
          ...(catalog?.signal ? { signal: catalog.signal } : {}),
          ...(body === undefined
            ? {}
            : {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
        },
      );
    } catch {
      throw new WeddingGiftsApiError(0, "NETWORK_ERROR");
    }
    const value: unknown =
      resource === "gifts"
        ? await this.readCatalogValue(response, catalog?.signal)
        : await response.json().catch(() => null);
    if (catalog?.signal?.aborted)
      throw new WeddingGiftsApiError(502, "INVALID_API_RESPONSE");
    if (!response.ok) {
      if (resource === "gift-checkouts")
        throw new WeddingGiftsApiError(
          response.status,
          "EXTERNAL_OUTCOME_UNKNOWN",
        );
      const code =
        value &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string"
          ? value.code
          : "REQUEST_FAILED";
      throw new WeddingGiftsApiError(response.status, code);
    }
    try {
      return parse(value);
    } catch (cause) {
      if (cause instanceof WeddingGiftsApiError) throw cause;
      throw new WeddingGiftsApiError(502, "INVALID_API_RESPONSE");
    }
  }
}

export function getGiftErrorMessage(error: unknown): string {
  if (error instanceof WeddingGiftsApiError) {
    if (
      error.code === "RECEIVING_NOT_READY" ||
      error.code === "PROVIDER_MODE_UNAVAILABLE" ||
      error.code === "POLICY_UNAVAILABLE"
    )
      return "Os presentes ainda não estão disponíveis para pagamento.";
    if (error.code === "QUOTE_EXPIRED" || error.code === "QUOTE_INVALID")
      return "O valor precisa ser atualizado. Escolha novamente a forma de pagamento.";
    if (error.code === "EXTERNAL_OUTCOME_UNKNOWN")
      return "O pagamento ainda está sendo verificado. Aguarde antes de tentar novamente.";
    if (error.code === "SITE_INACTIVE" || error.code === "SITE_EXPIRED")
      return "Os presentes deste casamento estão indisponíveis.";
    if (error.status === 429)
      return "Aguarde um momento antes de tentar novamente.";
  }
  return "Não foi possível concluir agora. Tente novamente.";
}
