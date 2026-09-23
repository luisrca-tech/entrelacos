import {
  type InvitationAccessInput,
  type InvitationRsvpResponse,
  type InvitationRsvpWriteInput,
  type InvitationSessionResponse,
  invitationAccessInputSchema,
  invitationAccessPinSchema,
  invitationRsvpResponseSchema,
  invitationRsvpWriteInputSchema,
  invitationSessionLeaveResponseSchema,
  invitationSessionReadResponseSchema,
  invitationSessionResponseSchema,
  opaqueTokenSchema,
  originSchema,
  type RsvpWriteResponse,
  rsvpWriteResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export type GuestSessionReadResponse = Omit<
  InvitationSessionResponse,
  "sessionToken"
>;

export type GuestSessionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export const guestSessionStoragePrefix = "entrelacos:guest-session:";

export function getGuestSessionStorageKey(siteId: string): string {
  return `${guestSessionStoragePrefix}${encodeURIComponent(siteId)}`;
}

export function readGuestSession(
  storage: GuestSessionStorage,
  siteId: string,
): string | null {
  const token = storage.getItem(getGuestSessionStorageKey(siteId));
  return token && opaqueTokenSchema.safeParse(token).success ? token : null;
}

export function writeGuestSession(
  storage: GuestSessionStorage,
  siteId: string,
  token: string,
): void {
  const parsed = opaqueTokenSchema.parse(token);
  storage.setItem(getGuestSessionStorageKey(siteId), parsed);
}

export function clearGuestSession(
  storage: GuestSessionStorage,
  siteId: string,
): void {
  storage.removeItem(getGuestSessionStorageKey(siteId));
}

export function guestSessionEventName(siteId: string): string {
  return `entrelacos:guest-session:${encodeURIComponent(siteId)}`;
}

export function publishGuestSessionChange(siteId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(guestSessionEventName(siteId)));
}

export function browserGuestSessionStorage(): GuestSessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getGuestLeaveNotice(serverConfirmed: boolean): string {
  return serverConfirmed
    ? "Você saiu. Para entrar novamente, confirme seus dados."
    : "A sessão foi removida neste navegador, mas a saída não pôde ser confirmada no servidor.";
}

export class GuestAccessApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "GuestAccessApiError";
  }
}

export type GuestAccessApiOptions = {
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

function parseRetryAfter(value: JsonRecord): number | undefined {
  const retry = value.retryAfterSeconds ?? value.retryAfter;
  if (typeof retry === "number" && Number.isFinite(retry))
    return Math.max(0, Math.ceil(retry));
  if (typeof retry === "string" && /^\d+$/.test(retry)) return Number(retry);
  return undefined;
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Math.max(0, Number(value));
}

function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export class GuestAccessApi {
  private readonly apiOrigin: string;
  private readonly siteId: string;
  private readonly fetcher: typeof fetch;

  constructor({ apiOrigin, siteId, fetcher = fetch }: GuestAccessApiOptions) {
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

  async access(
    input: InvitationAccessInput,
  ): Promise<InvitationSessionResponse> {
    const parsed = invitationAccessInputSchema.parse(input);
    return this.request(
      `/v1/public/sites/${encodeURIComponent(this.siteId)}/invitation/access`,
      {
        method: "POST",
        body: parsed,
      },
      (value) => invitationSessionResponseSchema.parse(value),
    );
  }

  async getSession(sessionToken: string): Promise<GuestSessionReadResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    return this.request(
      "/v1/public/invitation/session",
      { headers: { Authorization: `Bearer ${token}` } },
      (value) =>
        invitationSessionReadResponseSchema.parse({ ...asRecord(value) }),
    );
  }

  async getRsvp(sessionToken: string): Promise<InvitationRsvpResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    return this.request(
      "/v1/public/invitation/rsvp",
      { headers: { Authorization: `Bearer ${token}` } },
      (value) => invitationRsvpResponseSchema.parse(value),
    );
  }

  async saveRsvp(
    sessionToken: string,
    input: InvitationRsvpWriteInput,
  ): Promise<RsvpWriteResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    const body = invitationRsvpWriteInputSchema.parse(input);
    return this.request(
      "/v1/public/invitation/rsvp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      },
      (value) => rsvpWriteResponseSchema.parse(value),
    );
  }

  async leave(sessionToken: string): Promise<void> {
    const token = opaqueTokenSchema.parse(sessionToken);
    await this.request(
      "/v1/public/invitation/session/leave",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      (value) => {
        invitationSessionLeaveResponseSchema.parse(value);
        return undefined;
      },
    );
  }

  private url(path: string): string {
    return `${this.apiOrigin}${path}`;
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
      response = await this.fetcher(this.url(path), {
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
      throw new GuestAccessApiError(0, "NETWORK_ERROR");
    }
    const value = await parseJsonResponse(response);
    if (!response.ok) {
      const record = asRecord(value);
      throw new GuestAccessApiError(
        response.status,
        typeof record.code === "string" ? record.code : "REQUEST_FAILED",
        parseRetryAfter(record) ??
          parseRetryAfterHeader(response.headers.get("Retry-After")),
      );
    }
    try {
      return parse(value);
    } catch {
      throw new GuestAccessApiError(502, "INVALID_API_RESPONSE");
    }
  }
}

export function guestAccessErrorMessage(error: unknown): string {
  if (!(error instanceof GuestAccessApiError))
    return "Não foi possível concluir agora. Tente novamente.";
  if (error.code === "INVITATION_ACCESS_INVALID")
    return "Não foi possível confirmar esse telefone e PIN. Confira os dados e tente novamente.";
  if (error.code === "INVITATION_ACCESS_RATE_LIMITED")
    return error.retryAfterSeconds
      ? `Aguarde ${error.retryAfterSeconds} segundos antes de tentar novamente.`
      : "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  if (error.code === "UNAUTHORIZED")
    return "Esta sessão expirou. Comece novamente.";
  if (error.status === 429)
    return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  if (error.code === "SITE_INACTIVE")
    return "Este site está temporariamente indisponível.";
  if (error.code === "RSVP_CONFLICT")
    return "Os dados foram alterados em outro acesso. Revise as respostas antes de salvar novamente.";
  if (error.code === "RSVP_DEADLINE_PASSED")
    return "O prazo de confirmação terminou. As respostas continuam disponíveis para consulta.";
  if (error.status === 401) return "Esta sessão expirou. Comece novamente.";
  return "Não foi possível concluir agora. Tente novamente.";
}

export function isValidVerificationCode(value: string): boolean {
  return invitationAccessPinSchema.safeParse(value).success;
}
