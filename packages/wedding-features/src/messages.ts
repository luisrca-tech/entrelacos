import {
  type CreatePublicSiteMessageRequest,
  type CreatePublicSiteMessageResponse,
  createPublicSiteMessageRequestSchema,
  createPublicSiteMessageResponseSchema,
  originSchema,
  type PublicMuralQuery,
  type PublicMuralResponse,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export type WeddingMessagesApiOptions = {
  apiOrigin: string;
  siteId: string;
  fetcher?: typeof fetch;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : {};
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export class WeddingMessagesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "WeddingMessagesApiError";
  }
}

export class WeddingMessagesApi {
  private readonly apiOrigin: string;
  private readonly siteId: string;
  private readonly fetcher: typeof fetch;

  constructor({
    apiOrigin,
    siteId,
    fetcher = fetch,
  }: WeddingMessagesApiOptions) {
    try {
      originSchema.parse(apiOrigin);
    } catch {
      throw new Error("Invalid public API origin");
    }
    try {
      siteIdSchema.parse(siteId);
    } catch {
      throw new Error("Invalid public site ID");
    }
    this.apiOrigin = apiOrigin;
    this.siteId = siteId;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async getMural(
    query: Partial<PublicMuralQuery> = {},
  ): Promise<PublicMuralResponse> {
    const parsed = publicMuralQuerySchema.parse(query);
    const parameters = new URLSearchParams();
    if (parsed.cursor) parameters.set("cursor", parsed.cursor);
    parameters.set("limit", String(parsed.limit));
    return this.request(
      `/v1/public/sites/${encodeURIComponent(this.siteId)}/mural?${parameters.toString()}`,
      {},
      (value) => publicMuralResponseSchema.parse(value),
    );
  }

  async createPublicSiteMessage(
    input: CreatePublicSiteMessageRequest,
  ): Promise<CreatePublicSiteMessageResponse> {
    const body = createPublicSiteMessageRequestSchema.parse(input);
    return this.request(
      `/v1/public/sites/${encodeURIComponent(this.siteId)}/mural`,
      { method: "POST", body },
      (value) => createPublicSiteMessageResponseSchema.parse(value),
    );
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    },
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiOrigin}${path}`, {
        method: options.method ?? "GET",
        credentials: "omit",
        cache: "no-store",
        ...(options.body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(options.body),
            }),
      });
    } catch {
      throw new WeddingMessagesApiError(0, "NETWORK_ERROR");
    }
    const value = await parseJson(response);
    if (!response.ok) {
      const record = asRecord(value);
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new WeddingMessagesApiError(
        response.status,
        typeof record.code === "string" ? record.code : "REQUEST_FAILED",
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.ceil(retryAfter)
          : undefined,
      );
    }
    try {
      return parse(value);
    } catch {
      throw new WeddingMessagesApiError(502, "INVALID_API_RESPONSE");
    }
  }
}

export function countMessageCodePoints(value: string): number {
  return Array.from(value.replace(/\r\n?/g, "\n")).length;
}

export function muralRefreshEventName(siteId: string): string {
  return `entrelacos:mural-refresh:${encodeURIComponent(siteId)}`;
}

export function getMessageErrorMessage(error: unknown): string {
  if (!(error instanceof WeddingMessagesApiError)) {
    return "Não foi possível concluir agora. Tente novamente.";
  }
  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return error.retryAfterSeconds
      ? `Muitas mensagens foram enviadas em pouco tempo. Tente novamente em ${error.retryAfterSeconds} segundos.`
      : "Muitas mensagens foram enviadas em pouco tempo. Aguarde antes de tentar novamente.";
  }
  if (error.code === "MURAL_DISABLED") {
    return "O mural está desativado neste momento.";
  }
  if (error.code === "SITE_INACTIVE" || error.code === "SITE_NOT_FOUND") {
    return "Este site está temporariamente indisponível.";
  }
  if (error.status === 0 || error.code === "NETWORK_ERROR") {
    return "Não foi possível acessar o mural por falha de conexão.";
  }
  return "Não foi possível concluir agora. Tente novamente.";
}
