import { createHmac, timingSafeEqual } from "node:crypto";
import { giftQuoteSchema, siteIdSchema } from "@entrelacos/contracts";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";

export type FinancialReauthenticationAction =
  | "CONFIGURE_RECEIVING"
  | "REQUEST_WITHDRAWAL";
export interface FinancialReauthenticationOptions {
  keyId: string;
  key: Uint8Array;
  maxAgeMs: number;
  now(): Date;
  // Must enforce a shared per-user limit across sessions, instances and actions.
  rateLimit: { consume(userId: string): Promise<boolean> };
  password: {
    verifyPassword(input: {
      userId: string;
      password: string;
    }): Promise<boolean>;
  };
}
export interface FinancialReauthenticationResponse {
  reauthenticationToken: string;
  expiresAt: string;
}
export interface FinancialReauthentication {
  authenticate(
    actor: FinancialActor,
    action: FinancialReauthenticationAction,
    password: string,
  ): Promise<FinancialReauthenticationResponse>;
  readProof(
    actor: FinancialActor,
    action: FinancialReauthenticationAction,
    token: string,
  ): RecentFinancialAuthenticationEvidence;
}
export class FinancialReauthenticationError extends Error {
  constructor(
    readonly status: 403 | 429 | 503,
    readonly code:
      | "RECENT_AUTH_REQUIRED"
      | "REAUTHENTICATION_RATE_LIMITED"
      | "REAUTHENTICATION_UNAVAILABLE",
  ) {
    super(
      code === "REAUTHENTICATION_UNAVAILABLE"
        ? "Financial reauthentication unavailable"
        : code === "REAUTHENTICATION_RATE_LIMITED"
          ? "Financial reauthentication rate limited"
          : "Verified recent authentication required",
    );
    this.name = "FinancialReauthenticationError";
  }
}
function reject(): never {
  throw new FinancialReauthenticationError(403, "RECENT_AUTH_REQUIRED");
}
function unavailable(): never {
  throw new FinancialReauthenticationError(503, "REAUTHENTICATION_UNAVAILABLE");
}
function readActor(value: FinancialActor): FinancialActor {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 3 ||
    !siteIdSchema.safeParse(value.siteId).success ||
    ![value.userId, value.sessionId].every(
      (v) => giftQuoteSchema.shape.siteId.safeParse(v).success,
    )
  )
    reject();
  return {
    userId: value.userId,
    siteId: value.siteId,
    sessionId: value.sessionId,
  };
}
function action(
  value: FinancialReauthenticationAction,
): FinancialReauthenticationAction {
  if (value !== "CONFIGURE_RECEIVING" && value !== "REQUEST_WITHDRAWAL")
    reject();
  return value;
}
function clock(now: () => Date): number {
  const value = now();
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    value.getTime() < 0
  )
    unavailable();
  return value.getTime();
}
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) reject();
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) reject();
  return result;
}

// The token proves recent password verification only. Each action endpoint must
// reread the active session, current membership and designated recipient binding.
// It grants no recipient ownership, provider approval, balance or transfer right.
export function createFinancialReauthentication(
  options: FinancialReauthenticationOptions,
): FinancialReauthentication {
  if (
    !options ||
    !siteIdSchema.safeParse(options.keyId).success ||
    !(options.key instanceof Uint8Array) ||
    options.key.byteLength !== 32 ||
    !Number.isSafeInteger(options.maxAgeMs) ||
    options.maxAgeMs < 1 ||
    options.maxAgeMs > 300000 ||
    typeof options.now !== "function" ||
    typeof options.rateLimit?.consume !== "function" ||
    typeof options.password?.verifyPassword !== "function"
  )
    unavailable();
  const key = Buffer.from(options.key);
  const keyId = options.keyId;
  const maxAgeMs = options.maxAgeMs;
  const now = options.now;
  const consume = options.rateLimit.consume.bind(options.rateLimit);
  const verify = options.password.verifyPassword.bind(options.password);
  const signature = (payload: string) =>
    createHmac("sha256", key).update(`fr1.${payload}`, "utf8").digest();
  return {
    async authenticate(actorInput, purpose, password) {
      try {
        const actor = readActor(actorInput);
        purpose = action(purpose);
        if (
          typeof password !== "string" ||
          password.length < 1 ||
          password.length > 200
        )
          reject();
        const started = clock(now);
        const allowed = await consume(actor.userId);
        if (allowed === false)
          throw new FinancialReauthenticationError(
            429,
            "REAUTHENTICATION_RATE_LIMITED",
          );
        if (allowed !== true) unavailable();
        if ((await verify({ userId: actor.userId, password })) !== true)
          reject();
        const authenticatedAt = clock(now);
        if (authenticatedAt < started) unavailable();
        const expiresAt = authenticatedAt + maxAgeMs;
        if (
          !Number.isSafeInteger(expiresAt) ||
          !Number.isFinite(new Date(expiresAt).getTime())
        )
          unavailable();
        const payload = Buffer.from(
          JSON.stringify({
            version: 1,
            keyId,
            ...actor,
            action: purpose,
            authenticatedAt,
            expiresAt,
          }),
          "utf8",
        ).toString("base64url");
        return {
          reauthenticationToken: `fr1.${payload}.${signature(payload).toString("base64url")}`,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      } catch (error) {
        if (error instanceof FinancialReauthenticationError) throw error;
        return unavailable();
      }
    },
    readProof(actorInput, purpose, token) {
      try {
        const actor = readActor(actorInput);
        purpose = action(purpose);
        if (typeof token !== "string" || token.length > 4096) reject();
        const parts = token.split(".");
        if (parts.length !== 3 || parts[0] !== "fr1") reject();
        const supplied = decode(parts[2]);
        const expected = signature(parts[1]);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          reject();
        const data = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[1])),
        ) as Record<string, unknown>;
        const keys = [
          "version",
          "keyId",
          "userId",
          "siteId",
          "sessionId",
          "action",
          "authenticatedAt",
          "expiresAt",
        ];
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          Object.keys(data).length !== keys.length ||
          Object.keys(data).some((key) => !keys.includes(key)) ||
          data.version !== 1 ||
          data.keyId !== keyId ||
          data.userId !== actor.userId ||
          data.siteId !== actor.siteId ||
          data.sessionId !== actor.sessionId ||
          data.action !== purpose ||
          typeof data.authenticatedAt !== "number" ||
          typeof data.expiresAt !== "number" ||
          !Number.isSafeInteger(data.authenticatedAt) ||
          !Number.isSafeInteger(data.expiresAt)
        )
          reject();
        const current = clock(now);
        if (
          data.authenticatedAt < 0 ||
          data.authenticatedAt > current ||
          data.expiresAt <= current ||
          data.expiresAt - data.authenticatedAt !== maxAgeMs ||
          current - data.authenticatedAt > maxAgeMs
        )
          reject();
        return {
          ...actor,
          proofKind: "PASSWORD_REAUTHENTICATION",
          verification: "verified",
          provenance: "backend",
          authenticatedAt: new Date(data.authenticatedAt),
          expiresAt: new Date(data.expiresAt),
        };
      } catch (error) {
        if (error instanceof FinancialReauthenticationError) throw error;
        return reject();
      }
    },
  };
}
