import { isDeepStrictEqual } from "node:util";
import {
  type GiftPurchaseHistoryDetailResponse,
  type GiftPurchaseHistoryPageResponse,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryPageResponseSchema,
  giftPurchaseHistoryScopeSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import type { BetterAuthOptions } from "better-auth";
import type { AuthDatabase } from "./auth";
import { type AuthInstance, readAdministrativeSession } from "./authHttp";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import { assertFinancialReadAccess } from "./financialAuthorization";

export interface GiftPaymentHistoryReadScope {
  readonly siteId: string;
  readonly mode: "sandbox" | "live";
  readonly policy: "SITE_HISTORY";
  readonly userId: string;
  readonly sessionId: string;
  readonly membershipId: string;
}
export interface GiftPaymentHistoryRepository {
  readonly database: AuthDatabase;
  readonly mode: "sandbox" | "live";
  readonly applicationEnvironment: "test" | "development" | "production";
  readonly policy: "SITE_HISTORY";
  readPurchasePage(
    scope: GiftPaymentHistoryReadScope,
    cursor: string | null,
  ): Promise<GiftPurchaseHistoryPageResponse>;
  readPurchaseDetailPage(
    scope: GiftPaymentHistoryReadScope,
    orderId: string,
    cursor: string | null,
  ): Promise<GiftPurchaseHistoryDetailResponse>;
  close(): Promise<void>;
}
export interface GiftPaymentHistoryReadInput {
  readonly request: Request;
  readonly siteId: string;
  readonly cursor?: string | null;
}
export interface GiftPaymentHistoryReadOwner<T> {
  readonly result: Promise<T>;
  readonly completion: Promise<void>;
  cancel(): void;
}
export interface GiftPaymentHistoryService {
  readonly available: boolean;
  readPurchasePage(
    input: GiftPaymentHistoryReadInput,
  ): GiftPaymentHistoryReadOwner<GiftPurchaseHistoryPageResponse>;
  readPurchaseDetailPage(
    input: GiftPaymentHistoryReadInput & { readonly orderId: string },
  ): GiftPaymentHistoryReadOwner<GiftPurchaseHistoryDetailResponse>;
  close(): Promise<void>;
}
export interface GiftPaymentHistoryOptions {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  policy: "SITE_HISTORY";
  adminOrigin: string;
  now(): Date;
  authentication?: { auth: AuthInstance; db: AuthDatabase };
  repository?: GiftPaymentHistoryRepository;
}
export class GiftPaymentHistoryError extends Error {
  readonly status = 503;
  readonly code = "GIFT_PAYMENT_HISTORY_UNAVAILABLE";
  constructor() {
    super("Purchase history unavailable");
    this.name = "GiftPaymentHistoryError";
  }
}
export function historyUnavailable(): never {
  throw new GiftPaymentHistoryError();
}
export function readGiftPaymentHistoryScope(
  value: GiftPaymentHistoryReadScope,
): GiftPaymentHistoryReadScope {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "membershipId,mode,policy,sessionId,siteId,userId"
  )
    return historyUnavailable();
  const publicScope = giftPurchaseHistoryScopeSchema.parse({
    siteId: value.siteId,
    mode: value.mode,
    policy: value.policy,
  });
  for (const id of [value.userId, value.sessionId, value.membershipId])
    if (!siteAccessSchema.shape.userId.safeParse(id).success)
      return historyUnavailable();
  return Object.freeze({
    ...publicScope,
    userId: value.userId,
    sessionId: value.sessionId,
    membershipId: value.membershipId,
  });
}
function failed<T>(): GiftPaymentHistoryReadOwner<T> {
  const result = Promise.reject<T>(new GiftPaymentHistoryError());
  void result.catch(() => {});
  return Object.freeze({ result, completion: Promise.resolve(), cancel() {} });
}
const inactive: GiftPaymentHistoryService = Object.freeze({
  available: false,
  readPurchasePage: () => failed<GiftPurchaseHistoryPageResponse>(),
  readPurchaseDetailPage: () => failed<GiftPurchaseHistoryDetailResponse>(),
  close: async () => {},
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createGiftPaymentHistory(
  options?: GiftPaymentHistoryOptions,
): GiftPaymentHistoryService {
  try {
    if (
      !options ||
      !["sandbox", "live"].includes(options.mode) ||
      options.policy !== "SITE_HISTORY" ||
      !["test", "development", "production"].includes(
        options.applicationEnvironment,
      ) ||
      typeof options.now !== "function"
    )
      return inactive;
    const mode = options.mode as "sandbox" | "live",
      environment = options.applicationEnvironment,
      origin = options.adminOrigin,
      now = options.now.bind(options),
      authentication = options.authentication,
      repository = options.repository;
    if (
      !authentication ||
      !repository ||
      !origin ||
      new URL(origin).origin !== origin ||
      authentication.db !== repository.database ||
      mode !== repository.mode ||
      environment !== repository.applicationEnvironment ||
      repository.policy !== "SITE_HISTORY" ||
      (authentication.auth.options.session as BetterAuthOptions["session"])
        ?.deferSessionRefresh !== true ||
      !Array.isArray(authentication.auth.options.trustedOrigins) ||
      authentication.auth.options.trustedOrigins.length !== 1 ||
      authentication.auth.options.trustedOrigins[0] !== origin
    )
      return inactive;
    const auth = authentication.auth,
      db = authentication.db,
      readPage = repository.readPurchasePage.bind(repository),
      readDetail = repository.readPurchaseDetailPage.bind(repository),
      closeRepository = repository.close.bind(repository);
    let closing = false,
      closed: Promise<void> | undefined;
    const pending = new Set<{ completion: Promise<void>; cancel(): void }>();
    function start<T>(
      input: GiftPaymentHistoryReadInput & { orderId?: string },
      detail: boolean,
      schema: { parse(value: unknown): T },
    ): GiftPaymentHistoryReadOwner<T> {
      if (closing) return failed<T>();
      let aborted = false,
        clockFloor = -1n;
      const cancel = () => {
        aborted = true;
      };
      let finish!: () => void;
      const completion = new Promise<void>((yes) => {
        finish = yes;
      });
      const entry = { completion, cancel };
      pending.add(entry);
      let request: Request,
        siteId: string,
        cursor: string | null,
        orderId: string | undefined,
        originalSignal: AbortSignal | undefined;
      const sample = () => {
        if (closing || aborted) return historyUnavailable();
        const value = now(),
          time = databaseTimestampEpochMicroseconds(value);
        if (!(value instanceof Date) || time < 0n || time < clockFloor)
          return historyUnavailable();
        clockFloor = time;
        return new Date(value.getTime());
      };
      const result = (async () => {
        try {
          const keys = detail
            ? ["request", "siteId", "cursor", "orderId"]
            : ["request", "siteId", "cursor"];
          if (
            !input ||
            Object.keys(input).some((key) => !keys.includes(key)) ||
            !(input.request instanceof Request) ||
            !["GET", "HEAD"].includes(input.request.method) ||
            input.request.headers.get("origin") !== origin
          )
            return historyUnavailable();
          request = new Request(input.request.url, {
            method: "GET",
            headers: new Headers(input.request.headers),
          });
          originalSignal = input.request.signal;
          originalSignal.addEventListener("abort", cancel, { once: true });
          if (originalSignal.aborted) cancel();
          siteId = siteIdSchema.parse(input.siteId);
          cursor =
            giftPurchaseHistoryPageResponseSchema.shape.history.shape.nextCursor.parse(
              input.cursor ?? null,
            );
          if (detail) {
            orderId = siteAccessSchema.shape.userId.parse(input.orderId);
          }
          sample();
          async function authority() {
            const actor = await readAdministrativeSession(request, {
              auth,
              db,
              now: sample,
            });
            sample();
            if (actor?.user.role !== "SITE_ADMIN") return historyUnavailable();
            const matches = actor.memberships.filter(
              (item) => item.siteId === siteId,
            );
            if (matches.length !== 1) return historyUnavailable();
            const access = siteAccessSchema.parse(matches[0]);
            assertFinancialReadAccess(access, siteId);
            if (access.userId !== actor.user.id || !access.membershipId)
              return historyUnavailable();
            const scope = readGiftPaymentHistoryScope({
              siteId,
              mode,
              policy: "SITE_HISTORY",
              userId: actor.user.id,
              sessionId: actor.session.id,
              membershipId: access.membershipId,
            });
            return Object.freeze({
              scope,
              access: freeze(access),
              expiry: databaseTimestampEpochMicroseconds(
                actor.session.expiresAt,
              ).toString(),
            });
          }
          const original = await authority();
          sample();
          const value = detail
            ? await readDetail(original.scope, orderId as string, cursor)
            : await readPage(original.scope, cursor);
          sample();
          // Capture the original stored result before independent current native confirmation.
          const reply = freeze(schema.parse(value));
          const current = await authority();
          sample();
          if (!isDeepStrictEqual(current, original))
            return historyUnavailable();
          const envelope = reply as
            | GiftPurchaseHistoryPageResponse
            | GiftPurchaseHistoryDetailResponse;
          if (
            !isDeepStrictEqual(envelope.history.scope, {
              siteId,
              mode,
              policy: "SITE_HISTORY",
            }) ||
            (detail &&
              (envelope as GiftPurchaseHistoryDetailResponse).history
                .originalPurchase.orderId !== orderId)
          )
            return historyUnavailable();
          return reply;
        } catch {
          return historyUnavailable();
        } finally {
          originalSignal?.removeEventListener("abort", cancel);
          pending.delete(entry);
          finish();
        }
      })();
      void result.catch(() => {});
      return Object.freeze({ result, completion, cancel });
    }
    return Object.freeze({
      available: true,
      readPurchasePage: (input: GiftPaymentHistoryReadInput) =>
        start(input, false, giftPurchaseHistoryPageResponseSchema),
      readPurchaseDetailPage: (
        input: GiftPaymentHistoryReadInput & { orderId: string },
      ) => start(input, true, giftPurchaseHistoryDetailResponseSchema),
      close() {
        if (closed) return closed;
        closing = true;
        const entries = [...pending];
        closed = Promise.all(entries.map((entry) => entry.completion))
          .then(() => closeRepository())
          .catch(() => historyUnavailable());
        for (const entry of entries) entry.cancel();
        return closed;
      },
    });
  } catch {
    return inactive;
  }
}
