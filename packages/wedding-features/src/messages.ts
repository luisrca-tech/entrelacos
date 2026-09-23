import {
  type InvitationMessageResponse,
  invitationMessageResponseSchema,
  type MessageMutationInput,
  type MessageMutationResponse,
  messageMutationInputSchema,
  messageMutationResponseSchema,
  opaqueTokenSchema,
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

  async getInvitationMessage(
    sessionToken: string,
  ): Promise<InvitationMessageResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    return this.request(
      "/v1/public/invitation/message",
      { headers: { Authorization: `Bearer ${token}` } },
      (value) => invitationMessageResponseSchema.parse(value),
    );
  }

  async saveInvitationMessage(
    sessionToken: string,
    input: MessageMutationInput,
  ): Promise<MessageMutationResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    const body = messageMutationInputSchema.parse(input);
    return this.request(
      "/v1/public/invitation/message",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body,
      },
      (value) => messageMutationResponseSchema.parse(value),
    );
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

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiOrigin}${path}`, {
        method: options.method ?? "GET",
        credentials: "omit",
        cache: "no-store",
        headers: {
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new WeddingMessagesApiError(0, "NETWORK_ERROR");
    }
    const value = await parseJson(response);
    if (!response.ok) {
      const record = asRecord(value);
      throw new WeddingMessagesApiError(
        response.status,
        typeof record.code === "string" ? record.code : "REQUEST_FAILED",
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
  if (error.code === "MESSAGE_CONFLICT") {
    return "A mensagem foi alterada em outro acesso. Recarregue antes de tentar novamente.";
  }
  if (error.code === "MESSAGE_BLOCKED") {
    return "A administração bloqueou novas mensagens para este convite.";
  }
  if (error.code === "MURAL_DISABLED") {
    return "O mural está desativado neste momento.";
  }
  if (error.code === "MESSAGE_REMOVED") {
    return "Esta mensagem foi removida. Recarregue antes de publicar novamente.";
  }
  if (error.code === "SITE_INACTIVE") {
    return "Este site está temporariamente indisponível.";
  }
  if (error.status === 401 || error.code === "SESSION_INVALID") {
    return "Esta sessão expirou. Entre novamente para continuar.";
  }
  if (error.status === 0 || error.code === "NETWORK_ERROR") {
    return "Não foi possível acessar o mural por falha de conexão.";
  }
  return "Não foi possível concluir agora. Tente novamente.";
}
