import {
  demoGuestGrantSchema,
  type FamilyRsvpResponse,
  type FamilyRsvpWriteInput,
  type FamilySessionResponse,
  familyRsvpResponseSchema,
  familyRsvpWriteInputSchema,
  familySessionLeaveResponseSchema,
  familySessionReadResponseSchema,
  familySessionResponseSchema,
  type GuestChallengeStartResponse,
  type GuestChallengeVerifyInput,
  type GuestLookupInput,
  guestChallengeStartResponseSchema,
  guestChallengeVerifyInputSchema,
  guestLookupInputSchema,
  guestVerificationCodeSchema,
  opaqueTokenSchema,
  originSchema,
  type RsvpWriteResponse,
  rsvpWriteResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export type GuestDeliveryMode = "MANUAL_PIN" | "SIMULATED" | "REAL_SMS";

export type GuestChallengeStartResult = GuestChallengeStartResponse & {
  deliveryMode: GuestDeliveryMode;
  simulationCode?: string;
};

export type GuestSessionReadResponse = Omit<
  FamilySessionResponse,
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

export function getResendCountdownSeconds(
  resendAvailableAt: string,
  nowMs: number,
): number {
  const remainingMs = Date.parse(resendAvailableAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

export function getGuestDeliveryMessage(
  mode: GuestDeliveryMode,
  status: GuestChallengeStartResponse["sendStatus"],
): string {
  if (mode === "MANUAL_PIN") {
    return "Digite o PIN compartilhado pelos noivos ou pela cerimonial.";
  }
  if (mode === "SIMULATED") {
    return "Simulação local: este fluxo não envia SMS real.";
  }
  if (status === "PROVIDER_ACCEPTED") {
    return "Enviamos um código por SMS para o celular informado.";
  }
  return "A entrega do SMS ainda não foi confirmada pelo provedor.";
}

export function shouldDiscardGuestChallenge(
  status: GuestChallengeStartResponse["sendStatus"],
): boolean {
  return status === "FAILED_FINAL";
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

function parseChallengeStart(value: unknown): GuestChallengeStartResult {
  return guestChallengeStartResponseSchema.parse(value);
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

  async start(
    input: GuestLookupInput,
    demoGrant?: string,
  ): Promise<GuestChallengeStartResult> {
    const parsed = guestLookupInputSchema.parse(input);
    const grant = demoGrant ? demoGuestGrantSchema.parse(demoGrant) : undefined;
    return this.request(
      `/v1/public/sites/${encodeURIComponent(this.siteId)}/guest/challenge`,
      {
        method: "POST",
        body: parsed,
        ...(grant ? { headers: { "X-EntreLacos-Demo-Grant": grant } } : {}),
      },
      parseChallengeStart,
    );
  }

  async resend(
    challengeId: string,
    demoGrant?: string,
  ): Promise<GuestChallengeStartResult> {
    const parsed = opaqueTokenSchema.parse(challengeId);
    const grant = demoGrant ? demoGuestGrantSchema.parse(demoGrant) : undefined;
    return this.request(
      `/v1/public/guest/challenge/${encodeURIComponent(parsed)}/resend`,
      {
        method: "POST",
        body: { challengeId: parsed },
        ...(grant ? { headers: { "X-EntreLacos-Demo-Grant": grant } } : {}),
      },
      parseChallengeStart,
    );
  }

  async verify(
    input: GuestChallengeVerifyInput,
  ): Promise<FamilySessionResponse> {
    const parsed = guestChallengeVerifyInputSchema.parse(input);
    return this.request(
      `/v1/public/guest/challenge/${encodeURIComponent(parsed.challengeId)}/verify`,
      {
        method: "POST",
        body: { challengeId: parsed.challengeId, code: parsed.code },
      },
      (value) => familySessionResponseSchema.parse(value),
    );
  }

  async getSession(sessionToken: string): Promise<GuestSessionReadResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    return this.request(
      "/v1/public/family/session",
      { headers: { Authorization: `Bearer ${token}` } },
      (value) => familySessionReadResponseSchema.parse({ ...asRecord(value) }),
    );
  }

  async getRsvp(sessionToken: string): Promise<FamilyRsvpResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    return this.request(
      "/v1/public/family/rsvp",
      { headers: { Authorization: `Bearer ${token}` } },
      (value) => familyRsvpResponseSchema.parse(value),
    );
  }

  async saveRsvp(
    sessionToken: string,
    input: FamilyRsvpWriteInput,
  ): Promise<RsvpWriteResponse> {
    const token = opaqueTokenSchema.parse(sessionToken);
    const body = familyRsvpWriteInputSchema.parse(input);
    return this.request(
      "/v1/public/family/rsvp",
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
      "/v1/public/family/session/leave",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      (value) => {
        familySessionLeaveResponseSchema.parse(value);
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
  if (error.code === "GUEST_NOT_FOUND" || error.code === "LOOKUP_NOT_FOUND")
    return "Não encontramos um convite com esses dados. Confira o nome completo e o celular.";
  if (error.code === "FOREIGN_GUEST_CONTACT_ADMIN")
    return "Este convite usa número estrangeiro e precisa de atendimento administrativo. Não há SMS ou outra alternativa de autenticação.";
  if (
    error.code === "OTP_COOLDOWN" ||
    error.code === "CHALLENGE_COOLDOWN" ||
    error.code === "OTP_RATE_LIMIT" ||
    error.code === "OTP_SEND_RATE_LIMITED" ||
    error.code === "OTP_VERIFY_RATE_LIMITED" ||
    error.code === "LOOKUP_RATE_LIMITED"
  )
    return error.retryAfterSeconds
      ? `Aguarde ${error.retryAfterSeconds} segundos antes de tentar novamente.`
      : "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  if (error.code === "RESEND_TOO_SOON")
    return error.retryAfterSeconds
      ? `Aguarde ${error.retryAfterSeconds} segundos para reenviar o código.`
      : "Aguarde um pouco para reenviar o código.";
  if (error.code === "OTP_WRONG_CODE" || error.code === "INVALID_CODE")
    return "O código ou PIN não confere. Confira o valor e tente novamente.";
  if (error.code === "OTP_LOCKED")
    return "Muitas tentativas. Aguarde o desbloqueio e tente novamente.";
  if (error.code === "OTP_EXPIRED" || error.code === "CHALLENGE_EXPIRED")
    return "Este acesso expirou. Confirme seus dados novamente.";
  if (
    error.code === "SMS_QUOTA_NOT_CONFIGURED" ||
    error.code === "SMS_QUOTA_EXCEEDED"
  )
    return "O envio de SMS está indisponível. Entre em contato com a organização do casamento para receber seu PIN de acesso.";
  if (
    error.code === "CHALLENGE_NOT_FOUND" ||
    error.code === "CHALLENGE_NOT_ACTIVE" ||
    error.code === "UNAUTHORIZED"
  )
    return "Esta verificação expirou. Comece novamente.";
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
  return guestVerificationCodeSchema.safeParse(value).success;
}
