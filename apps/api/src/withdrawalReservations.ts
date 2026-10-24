import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  giftCentsSchema,
  giftQuoteSchema,
  type ReceivingReadiness,
  receivingReadinessSchema,
  siteAccessSchema,
  siteIdSchema,
  type WithdrawalIntent,
  type WithdrawalPreview,
  type WithdrawalRequestContext,
  type WithdrawalRequestStatus,
  withdrawalIntentSchema,
  withdrawalPreviewInputSchema,
  withdrawalPreviewSchema,
  withdrawalRequestContextSchema,
  withdrawalRequestStatusSchema,
  withdrawalReservationInputSchema,
} from "@entrelacos/contracts";
import type { AsaasBalanceObservation } from "./asaasHttpClient";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import {
  assertFinancialReadAccess,
  assertRecipientFinancialAction,
  type FinancialActor,
  FinancialAuthorizationError,
  type FinancialRecipientBinding,
  type RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import { allowsLiveSite } from "./liveSitePolicy";
import { ReceivingReadinessServiceError } from "./receivingReadiness";
import { logWithdrawalFailure } from "./withdrawalDiagnostics";

import {
  readWithdrawalPayoutBinding,
  sameWithdrawalPayout,
  type WithdrawalPayoutBinding,
} from "./withdrawalPayout";

type Environment = "sandbox" | "live";

// All context, proof and ports are server-loaded. These types do not establish
// provider ownership, SQL atomicity or authentication merely by matching flags.
export interface WithdrawalReservationContext {
  siteId: string;
  isDemo: boolean;
  mode: Environment;
  verification: "verified" | "unverified";
  accountId: string | null;
  bankReference: string | null;
  recipientBinding: FinancialRecipientBinding | null;
  readiness: ReceivingReadiness | null;
}

export interface WithdrawalFeeScope {
  siteId: string;
  accountId: string;
  accountReference: string;
  environment: Environment;
  bankReference: string;
  destinationVersion: number;
  amountCents: number;
  currency: "BRL";
}
export type WithdrawalPresentationScope = Omit<
  WithdrawalFeeScope,
  "amountCents" | "currency"
>;

export interface WithdrawalFeeQuote extends WithdrawalFeeScope {
  feeCents: number;
  feeSemantics?: "MAXIMUM" | "MAXIMUM_WITH_MINIMUM_NET";
  policyVersion: string;
  provenance: "provider" | "simulation";
  verification: "verified" | "unverified";
  observedAt: Date;
  expiresAt: Date;
}

export interface WithdrawalReservationSnapshot {
  readonly intent: WithdrawalIntent;
  readonly requestId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  readonly accountReference: string;
  readonly recipientReference: string;
  readonly bankReference: string;
  readonly environment: Environment;
  readonly operationId: string;
  readonly requestHash: string;
  readonly authenticationAuditHash: string;
  readonly feeQuote: {
    readonly feeCents: number;
    readonly feeSemantics?: "MAXIMUM" | "MAXIMUM_WITH_MINIMUM_NET";
    readonly policyVersion: string;
    readonly provenance: "provider" | "simulation";
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly balance: {
    readonly balanceCents: number;
    readonly observedAt: string;
  };
}

export interface WithdrawalReservationRecord {
  readonly snapshot: WithdrawalReservationSnapshot;
  // Current persisted state, including UNKNOWN; never replaced by a new hold.
  readonly intent: WithdrawalIntent;
}

export interface WithdrawalReservationCurrentAuthorization {
  readonly actor: FinancialActor;
  readonly recentAuth: RecentFinancialAuthenticationEvidence;
}

export interface WithdrawalReservationLockedState {
  access: unknown;
  currentSession: FinancialActor | null;
  context: WithdrawalReservationContext | null;
  existingReservation: WithdrawalReservationRecord | null;
  // Authoritative SUM of HELD commitments, including UNKNOWN, under account lock.
  heldCents: bigint | null;
  unresolvedFinancialEventCount: number | null;
  // Authoritative account-locked count of completed withdrawals/debits at or
  // after balance.observedAt. Even a resolved event can invalidate an old GET.
  balanceEffectsAfterObservationCount: number | null;
}

export interface WithdrawalReservationRepository {
  findByRequest(
    siteId: string,
    requestId: string,
  ): Promise<WithdrawalReservationRecord | null>;
  // Lock the site/request and account, load current session/member/context and
  // authoritative holds/events and post-observation balance effects, await
  // authorization, then commit exactly once. Completion/refund writers must use
  // the same account lock and record effects before releasing their commitment.
  // A same-request race must return its original record without another hold.
  // Return only after commit; uncertain commits remain held until reconciliation.
  reserveWithdrawal(
    snapshot: WithdrawalReservationSnapshot,
    authorizeLockedCurrentState: (
      state: WithdrawalReservationLockedState,
    ) => Promise<void>,
    currentAuthorization: WithdrawalReservationCurrentAuthorization,
    confirmation?: WithdrawalConfirmationReference,
  ): Promise<WithdrawalReservationRecord>;
  readRequest?(
    attempt: WithdrawalRequestReadAttempt,
  ): Promise<WithdrawalRequestStatus>;
  readContext?(
    attempt: WithdrawalContextReadAttempt,
  ): Promise<WithdrawalRequestContext>;
  findConsent?(
    attempt: WithdrawalRequestReadAttempt,
  ): Promise<WithdrawalConsentRecord | null>;
  issuePreview?(
    snapshot: WithdrawalConsentSnapshot,
    scopeRevision: string,
    attempt: WithdrawalReadAttempt,
  ): Promise<WithdrawalRequestStatus>;
  recoverWithdrawal?(
    attempt: WithdrawalProtectedRequestAttempt,
  ): Promise<WithdrawalReservationRecord | null>;
  sealUncreatedRequest?(
    attempt: WithdrawalSealRequestAttempt,
  ): Promise<WithdrawalRequestStatus>;
}

export interface WithdrawalReadAttempt {
  actor: FinancialActor | null;
  access: unknown;
}
export interface WithdrawalContextReadAttempt extends WithdrawalReadAttempt {
  cursor?: string;
}
export interface WithdrawalRequestReadAttempt extends WithdrawalReadAttempt {
  requestId: string;
}
export interface WithdrawalProtectedRequestAttempt
  extends WithdrawalRequestReadAttempt {
  recentAuth: RecentFinancialAuthenticationEvidence | null;
}
export interface WithdrawalSealRequestAttempt
  extends WithdrawalRequestReadAttempt {
  recentAuth?: RecentFinancialAuthenticationEvidence | null;
}
export interface WithdrawalPreviewAttempt extends WithdrawalReadAttempt {
  input: unknown;
}
export interface WithdrawalConfirmationReference {
  requestId: string;
  previewHash: string;
  requestRevision: "1";
}
// These are internal stored-evidence ports. Matching caller flags never establish
// bank masking or ownership; an adapter must read the exact stored association.
export interface WithdrawalVerifiedPresentation extends WithdrawalFeeScope {
  payout?: WithdrawalPayoutBinding;
  source: "stored";
  verification: "verified";
  provenance: "provider" | "simulation";
  operatorUserId: string;
  recipientReference: string;
  destinationId: string;
  evidenceId: string;
  verificationReference: string;
  evidenceObservedAt: Date;
  bankObservedAt: Date;
  operatorProfileUpdatedAt: Date;
  maskedDestination: string;
  operatorDisplayName: string;
}
export type WithdrawalStoredPresentation = Omit<
  WithdrawalVerifiedPresentation,
  "amountCents" | "currency"
>;
export interface WithdrawalConsentSnapshot {
  preview: WithdrawalPreview;
  scope: WithdrawalFeeScope;
  operatorUserId: string;
  recipientReference: string;
  presentation: Omit<
    WithdrawalVerifiedPresentation,
    "evidenceObservedAt" | "bankObservedAt" | "operatorProfileUpdatedAt"
  > & {
    evidenceObservedAt: string;
    bankObservedAt: string;
    operatorProfileUpdatedAt: string;
  };
  feeQuote: WithdrawalReservationSnapshot["feeQuote"];
}
export interface WithdrawalConsentRecord {
  snapshot: WithdrawalConsentSnapshot;
  previewHash: string;
  requestRevision: "1" | "2";
  state: "OPEN" | "COMMITTED" | "SEALED_NOT_CREATED";
}

function canonicalStoredInstant(value: unknown): string {
  const date = readDatabaseTimestamp(value);
  const micros = databaseTimestampEpochMicroseconds(date);
  if (micros < 0n) return deny("WITHDRAWAL_UNAVAILABLE");
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, `.${String(micros % 1_000_000n).padStart(6, "0")}Z`);
}
export function readWithdrawalConsentSnapshot(
  value: unknown,
): WithdrawalConsentSnapshot {
  try {
    const raw = exact(value, [
      "preview",
      "scope",
      "operatorUserId",
      "recipientReference",
      "presentation",
      "feeQuote",
    ]);
    const preview = withdrawalPreviewSchema.parse(raw.preview);
    const source = exact(raw.scope, [
      "siteId",
      "accountId",
      "accountReference",
      "environment",
      "bankReference",
      "destinationVersion",
      "amountCents",
      "currency",
    ]);
    const scope: WithdrawalFeeScope = {
      siteId: siteIdSchema.parse(source.siteId),
      accountId: id(source.accountId),
      accountReference: reference(source.accountReference),
      environment: preview.mode,
      bankReference: reference(source.bankReference),
      destinationVersion: preview.destinationVersion,
      amountCents: preview.amountCents,
      currency: "BRL",
    };
    if (
      source.siteId !== preview.siteId ||
      source.environment !== preview.mode ||
      source.destinationVersion !== preview.destinationVersion ||
      source.amountCents !== preview.amountCents ||
      source.currency !== "BRL"
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    const operatorUserId = id(raw.operatorUserId);
    const recipientReference = reference(raw.recipientReference);
    const p = exact(raw.presentation, [
      ...(Object.hasOwn(record(raw.presentation), "payout") ? ["payout"] : []),
      ...Object.keys(scope),
      "source",
      "verification",
      "provenance",
      "operatorUserId",
      "recipientReference",
      "destinationId",
      "evidenceId",
      "verificationReference",
      "evidenceObservedAt",
      "bankObservedAt",
      "operatorProfileUpdatedAt",
      "maskedDestination",
      "operatorDisplayName",
    ]);
    if (
      Object.entries(scope).some(([key, value]) => p[key] !== value) ||
      p.source !== "stored" ||
      p.verification !== "verified" ||
      !["provider", "simulation"].includes(String(p.provenance)) ||
      (p.provenance === "simulation" && preview.mode !== "sandbox") ||
      p.operatorUserId !== operatorUserId ||
      p.recipientReference !== recipientReference ||
      p.maskedDestination !== preview.maskedDestination ||
      p.operatorDisplayName !== preview.operatorDisplayName
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    const presentation: WithdrawalConsentSnapshot["presentation"] = {
      ...scope,
      source: "stored",
      verification: "verified",
      provenance: p.provenance as "provider" | "simulation",
      operatorUserId,
      recipientReference,
      destinationId: id(p.destinationId),
      evidenceId: id(p.evidenceId),
      verificationReference: reference(p.verificationReference),
      evidenceObservedAt: canonicalStoredInstant(p.evidenceObservedAt),
      bankObservedAt: canonicalStoredInstant(p.bankObservedAt),
      operatorProfileUpdatedAt: canonicalStoredInstant(
        p.operatorProfileUpdatedAt,
      ),
      ...(p.payout === undefined
        ? {}
        : { payout: readWithdrawalPayoutBinding(p.payout) }),
      maskedDestination: preview.maskedDestination,
      operatorDisplayName: preview.operatorDisplayName,
    };
    const f = exact(raw.feeQuote, [
      ...(Object.hasOwn(record(raw.feeQuote), "feeSemantics")
        ? ["feeSemantics"]
        : []),
      "feeCents",
      "policyVersion",
      "provenance",
      "observedAt",
      "expiresAt",
    ]);
    const feeQuote: WithdrawalConsentSnapshot["feeQuote"] = {
      feeCents: cents(f.feeCents),
      ...(f.feeSemantics === "MAXIMUM" ||
      f.feeSemantics === "MAXIMUM_WITH_MINIMUM_NET"
        ? {
            feeSemantics: f.feeSemantics as
              | "MAXIMUM"
              | "MAXIMUM_WITH_MINIMUM_NET",
          }
        : {}),
      policyVersion: id(f.policyVersion),
      provenance: f.provenance as "provider" | "simulation",
      observedAt: instant(f.observedAt),
      expiresAt: instant(f.expiresAt),
    };
    const issued = BigInt(Date.parse(preview.issuedAt)) * 1000n;
    if (
      feeQuote.feeCents !== preview.feeCents ||
      feeQuote.feeSemantics !== preview.feeSemantics ||
      (f.feeSemantics !== undefined &&
        f.feeSemantics !== "MAXIMUM" &&
        f.feeSemantics !== "MAXIMUM_WITH_MINIMUM_NET") ||
      (presentation.payout !== undefined &&
        (preview.payoutRecipientName !== presentation.payout.ownerName ||
          preview.maskedDestination !==
            `Pix ${presentation.payout.keyType}: ${presentation.payout.maskedKey}`)) ||
      feeQuote.policyVersion !== preview.policyVersion ||
      !["provider", "simulation"].includes(feeQuote.provenance) ||
      (feeQuote.provenance === "simulation" && preview.mode !== "sandbox") ||
      feeQuote.expiresAt !== preview.expiresAt ||
      Date.parse(feeQuote.observedAt) > Date.parse(preview.issuedAt) ||
      Date.parse(feeQuote.expiresAt) - Date.parse(feeQuote.observedAt) >
        300_000 ||
      [
        presentation.evidenceObservedAt,
        presentation.bankObservedAt,
        presentation.operatorProfileUpdatedAt,
      ].some((at) => databaseTimestampEpochMicroseconds(at) > issued)
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    return Object.freeze({
      preview: Object.freeze(preview),
      scope: Object.freeze(scope),
      operatorUserId,
      recipientReference,
      presentation: Object.freeze(presentation),
      feeQuote: Object.freeze(feeQuote),
    });
  } catch {
    return deny("WITHDRAWAL_UNAVAILABLE");
  }
}
export function hashWithdrawalConsentSnapshot(
  value: WithdrawalConsentSnapshot,
): string {
  return hash(["withdrawal.consent.v1", readWithdrawalConsentSnapshot(value)]);
}
export function readWithdrawalConsentRecord(
  value: unknown,
): WithdrawalConsentRecord {
  try {
    const raw = exact(value, [
      "snapshot",
      "previewHash",
      "requestRevision",
      "state",
    ]);
    const snapshot = readWithdrawalConsentSnapshot(raw.snapshot);
    if (
      raw.previewHash !== hashWithdrawalConsentSnapshot(snapshot) ||
      (raw.state === "OPEN"
        ? raw.requestRevision !== "1"
        : !["COMMITTED", "SEALED_NOT_CREATED"].includes(String(raw.state)) ||
          raw.requestRevision !== "2")
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    return Object.freeze({
      snapshot,
      previewHash: raw.previewHash as string,
      requestRevision: raw.requestRevision as "1" | "2",
      state: raw.state as WithdrawalConsentRecord["state"],
    });
  } catch {
    return deny("WITHDRAWAL_UNAVAILABLE");
  }
}

export type WithdrawalReservationOptions =
  | { mode: "disabled" }
  | {
      mode: Environment;
      applicationEnvironment: "development" | "test" | "production";
      liveDemoSiteId?: string;
      maxAuthAgeMs: number;
      freshnessMs: number;
      now(): Date;
      generateId(kind: "withdrawal" | "operation"): string;
      loadContext(siteId: string): Promise<WithdrawalReservationContext | null>;
      loadVerifiedPresentation?(
        scope: WithdrawalFeeScope,
      ): Promise<WithdrawalVerifiedPresentation | null>;
      feeQuotes: {
        quoteWithdrawal(scope: WithdrawalFeeScope): Promise<WithdrawalFeeQuote>;
      };
      balance: {
        getBalance(scope: WithdrawalFeeScope): Promise<AsaasBalanceObservation>;
      };
      repository: WithdrawalReservationRepository;
    };

export interface WithdrawalReservationAttempt {
  actor: FinancialActor | null;
  access: unknown;
  recentAuth: RecentFinancialAuthenticationEvidence | null;
  input: unknown;
  confirmation?: WithdrawalConfirmationReference;
}

export interface WithdrawalReservationService {
  createWithdrawal(
    attempt: WithdrawalReservationAttempt,
  ): Promise<WithdrawalIntent>;
  readContext(
    attempt: WithdrawalContextReadAttempt,
  ): Promise<WithdrawalRequestContext>;
  createPreview(
    attempt: WithdrawalPreviewAttempt,
  ): Promise<WithdrawalRequestStatus>;
  readRequest(
    attempt: WithdrawalRequestReadAttempt,
  ): Promise<WithdrawalRequestStatus>;
  confirmNew(
    attempt: WithdrawalProtectedRequestAttempt,
  ): Promise<WithdrawalIntent>;
  recoverExisting(
    attempt: WithdrawalProtectedRequestAttempt,
  ): Promise<WithdrawalIntent>;
  sealUncreatedRequest(
    attempt: WithdrawalSealRequestAttempt,
  ): Promise<WithdrawalRequestStatus>;
}

export class WithdrawalReservationServiceError extends Error {
  readonly title = "Withdrawal reservation is unavailable";
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code:
      | "WITHDRAWAL_INVALID"
      | "MEMBERSHIP_DENIED"
      | "RECENT_AUTH_REQUIRED"
      | "RECIPIENT_REQUIRED"
      | "DESTINATION_UNVERIFIED"
      | "REQUEST_CONFLICT"
      | "PREVIEW_EXPIRED"
      | "PROVIDER_MODE_UNAVAILABLE"
      | "FEE_QUOTE_UNAVAILABLE"
      | "PROVIDER_BALANCE_UNAVAILABLE"
      | "FINANCIAL_EVENTS_UNRESOLVED"
      | "INSUFFICIENT_FUNDS"
      | "WITHDRAWAL_UNAVAILABLE",
  ) {
    super("Withdrawal reservation is unavailable");
    this.name = "WithdrawalReservationServiceError";
    logWithdrawalFailure(this);
  }
}

function deny(
  code: WithdrawalReservationServiceError["code"],
  status: 400 | 403 | 409 | 503 = 503,
): never {
  throw new WithdrawalReservationServiceError(status, code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return deny("WITHDRAWAL_UNAVAILABLE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return deny("WITHDRAWAL_UNAVAILABLE");
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  const raw = record(value);
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return deny("WITHDRAWAL_UNAVAILABLE");
  return raw;
}

function id(value: unknown): string {
  const parsed = giftQuoteSchema.shape.siteId.safeParse(value);
  if (!parsed.success) return deny("WITHDRAWAL_UNAVAILABLE");
  return parsed.data;
}

function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return deny("WITHDRAWAL_UNAVAILABLE");
  return value;
}

function instant(value: unknown): string {
  const parsed = giftQuoteSchema.shape.expiresAt.safeParse(value);
  if (
    !parsed.success ||
    new Date(parsed.data).toISOString() !== parsed.data ||
    Date.parse(parsed.data) < 0
  )
    return deny("WITHDRAWAL_UNAVAILABLE");
  return parsed.data;
}

function time(value: unknown): number {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()))
    return deny("WITHDRAWAL_UNAVAILABLE");
  instant(value.toISOString());
  return value.getTime();
}

function cents(value: unknown): number {
  const parsed = giftCentsSchema.safeParse(value);
  if (!parsed.success) return deny("WITHDRAWAL_UNAVAILABLE");
  return parsed.data;
}

function hash(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
}

function requestHash(
  intent: Pick<
    WithdrawalIntent,
    "siteId" | "amountCents" | "destinationVersion" | "mode"
  >,
  requestId: string,
  operatorUserId: string,
): string {
  return hash([
    "withdrawal.reservation.v1",
    intent.siteId,
    requestId,
    operatorUserId,
    intent.mode,
    intent.amountCents,
    intent.destinationVersion,
  ]);
}

// Only validates the historical snapshot. It never grants current authority or
// assumes that an intent REQUESTED means provider execution or approval.
export function readWithdrawalReservationSnapshot(
  value: unknown,
): WithdrawalReservationSnapshot {
  try {
    const raw = exact(value, [
      "intent",
      "requestId",
      "accountId",
      "operatorUserId",
      "accountReference",
      "recipientReference",
      "bankReference",
      "environment",
      "operationId",
      "requestHash",
      "authenticationAuditHash",
      "feeQuote",
      "balance",
    ]);
    const intent = withdrawalIntentSchema.parse(raw.intent);
    const fee = exact(raw.feeQuote, [
      ...(Object.hasOwn(record(raw.feeQuote), "feeSemantics")
        ? ["feeSemantics"]
        : []),
      "feeCents",
      "policyVersion",
      "provenance",
      "observedAt",
      "expiresAt",
    ]);
    const balance = exact(raw.balance, ["balanceCents", "observedAt"]);
    const requestId = id(raw.requestId);
    const operatorUserId = id(raw.operatorUserId);
    const createdAt = instant(intent.createdAt);
    const observedAt = instant(fee.observedAt);
    const expiresAt = instant(fee.expiresAt);
    const balanceObservedAt = instant(balance.observedAt);
    const balanceCents = cents(balance.balanceCents);
    const feeCents = cents(fee.feeCents);
    if (
      !siteIdSchema.safeParse(intent.siteId).success ||
      intent.state !== "REQUESTED" ||
      intent.updatedAt !== createdAt ||
      (raw.environment !== "sandbox" && raw.environment !== "live") ||
      intent.mode !== raw.environment ||
      feeCents !== intent.feeCents ||
      (fee.feeSemantics !== undefined &&
        fee.feeSemantics !== "MAXIMUM" &&
        fee.feeSemantics !== "MAXIMUM_WITH_MINIMUM_NET") ||
      fee.feeSemantics !== intent.feeSemantics ||
      BigInt(intent.feeCents) + BigInt(intent.netCents) !==
        BigInt(intent.amountCents) ||
      balanceCents < intent.amountCents ||
      (fee.provenance !== "provider" && fee.provenance !== "simulation") ||
      (fee.provenance === "simulation" && raw.environment !== "sandbox") ||
      Date.parse(observedAt) > Date.parse(createdAt) ||
      Date.parse(expiresAt) <= Date.parse(createdAt) ||
      Date.parse(expiresAt) - Date.parse(observedAt) > 300_000 ||
      Date.parse(balanceObservedAt) > Date.parse(createdAt) ||
      Date.parse(createdAt) - Date.parse(balanceObservedAt) > 300_000 ||
      raw.requestHash !== requestHash(intent, requestId, operatorUserId) ||
      typeof raw.authenticationAuditHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.authenticationAuditHash)
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    return Object.freeze({
      intent: Object.freeze(intent),
      requestId,
      accountId: id(raw.accountId),
      operatorUserId,
      accountReference: reference(raw.accountReference),
      recipientReference: reference(raw.recipientReference),
      bankReference: reference(raw.bankReference),
      environment: raw.environment,
      operationId: id(raw.operationId),
      requestHash: raw.requestHash,
      authenticationAuditHash: raw.authenticationAuditHash,
      feeQuote: Object.freeze({
        feeCents,
        ...(fee.feeSemantics === "MAXIMUM" ||
        fee.feeSemantics === "MAXIMUM_WITH_MINIMUM_NET"
          ? {
              feeSemantics: fee.feeSemantics as
                | "MAXIMUM"
                | "MAXIMUM_WITH_MINIMUM_NET",
            }
          : {}),
        policyVersion: id(fee.policyVersion),
        provenance: fee.provenance,
        observedAt,
        expiresAt,
      }),
      balance: Object.freeze({ balanceCents, observedAt: balanceObservedAt }),
    });
  } catch {
    return deny("WITHDRAWAL_UNAVAILABLE");
  }
}

export function readWithdrawalReservationRecord(
  value: unknown,
): WithdrawalReservationRecord {
  try {
    const raw = exact(value, ["snapshot", "intent"]);
    const snapshot = readWithdrawalReservationSnapshot(raw.snapshot);
    const intent = withdrawalIntentSchema.parse(raw.intent);
    instant(intent.updatedAt);
    if (
      Date.parse(intent.updatedAt) < Date.parse(snapshot.intent.createdAt) ||
      !isDeepStrictEqual(
        { ...intent, state: "REQUESTED", updatedAt: snapshot.intent.createdAt },
        snapshot.intent,
      )
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    return Object.freeze({ snapshot, intent: Object.freeze(intent) });
  } catch {
    return deny("WITHDRAWAL_UNAVAILABLE");
  }
}

function actor(value: unknown): FinancialActor {
  try {
    const raw = exact(value, ["userId", "siteId", "sessionId"]);
    const site = siteIdSchema.parse(raw.siteId);
    return Object.freeze({
      userId: id(raw.userId),
      siteId: site,
      sessionId: id(raw.sessionId),
    });
  } catch {
    return deny("MEMBERSHIP_DENIED", 403);
  }
}

function eligible(access: unknown, currentActor: FinancialActor): void {
  assertFinancialReadAccess(access, currentActor.siteId);
  if (access.userId !== currentActor.userId) deny("MEMBERSHIP_DENIED", 403);
}

function captureProof(
  value: unknown,
  currentActor: FinancialActor,
  now: number,
  maxAge: number,
): RecentFinancialAuthenticationEvidence {
  try {
    const raw = exact(value, [
      "userId",
      "siteId",
      "sessionId",
      "proofKind",
      "verification",
      "provenance",
      "authenticatedAt",
      "expiresAt",
    ]);
    if (
      raw.userId !== currentActor.userId ||
      raw.siteId !== currentActor.siteId ||
      raw.sessionId !== currentActor.sessionId ||
      raw.verification !== "verified" ||
      raw.provenance !== "backend" ||
      (raw.proofKind !== "PASSWORD_REAUTHENTICATION" &&
        raw.proofKind !== "MFA_REAUTHENTICATION")
    )
      return deny("RECENT_AUTH_REQUIRED", 403);
    const result: RecentFinancialAuthenticationEvidence = Object.freeze({
      ...currentActor,
      proofKind: raw.proofKind,
      verification: "verified",
      provenance: "backend",
      authenticatedAt: new Date(time(raw.authenticatedAt)),
      expiresAt: new Date(time(raw.expiresAt)),
    });
    freshProof(result, now, maxAge);
    return result;
  } catch {
    return deny("RECENT_AUTH_REQUIRED", 403);
  }
}

function freshProof(
  proof: RecentFinancialAuthenticationEvidence,
  now: number,
  maxAge: number,
): void {
  const authenticated = time(proof.authenticatedAt);
  const expiry = time(proof.expiresAt);
  if (
    authenticated > now ||
    now - authenticated > maxAge ||
    expiry <= now ||
    expiry - authenticated > maxAge
  )
    deny("RECENT_AUTH_REQUIRED", 403);
}

function fresh(observed: number, now: number, freshnessMs: number): boolean {
  return observed <= now && now - observed <= freshnessMs;
}

function contextScope(
  value: unknown,
  siteId: string,
  mode: Environment,
  applicationEnvironment: "development" | "test" | "production",
  liveDemoSiteId?: string,
): WithdrawalReservationContext {
  const raw = record(value);
  if (
    raw.siteId !== siteId ||
    typeof raw.isDemo !== "boolean" ||
    raw.mode !== mode ||
    (raw.verification !== "verified" && raw.verification !== "unverified")
  )
    return deny("WITHDRAWAL_UNAVAILABLE");
  if (
    mode === "live" &&
    !allowsLiveSite({
      siteId,
      isDemo: raw.isDemo,
      mode,
      applicationEnvironment,
      liveDemoSiteId,
    })
  )
    return deny("PROVIDER_MODE_UNAVAILABLE", 409);
  const binding =
    raw.recipientBinding === null ? null : record(raw.recipientBinding);
  if (
    binding &&
    (binding.environment !== mode ||
      !Number.isSafeInteger(binding.destinationVersion) ||
      (binding.destinationVersion as number) < 1)
  )
    return deny("DESTINATION_UNVERIFIED", 409);
  return Object.freeze({
    siteId,
    isDemo: raw.isDemo,
    mode,
    verification: raw.verification,
    accountId: raw.accountId === null ? null : id(raw.accountId),
    bankReference:
      raw.bankReference === null ? null : reference(raw.bankReference),
    recipientBinding:
      binding === null
        ? null
        : Object.freeze({
            siteId: id(binding.siteId),
            operatorUserId: id(binding.operatorUserId),
            environment: mode,
            accountReference: reference(binding.accountReference),
            recipientReference: reference(binding.recipientReference),
            destinationVersion: binding.destinationVersion as number,
          }),
    readiness:
      raw.readiness === null
        ? null
        : Object.freeze(receivingReadinessSchema.parse(raw.readiness)),
  });
}

function receivingScope(
  context: WithdrawalReservationContext,
  currentActor: FinancialActor,
  access: unknown,
  proof: RecentFinancialAuthenticationEvidence,
  now: number,
  maxAge: number,
  freshnessMs: number,
  amountCents: number,
  destinationVersion: number,
): WithdrawalFeeScope {
  assertRecipientFinancialAction({
    action: "REQUEST_WITHDRAWAL",
    siteId: currentActor.siteId,
    environment: context.mode,
    access,
    actor: currentActor,
    recipientBinding: context.recipientBinding,
    recentAuth: proof,
    readiness: context.readiness,
    now: new Date(now),
    maxAuthAgeMs: maxAge,
  });
  if (
    context.verification !== "verified" ||
    !context.accountId ||
    !context.bankReference ||
    !context.recipientBinding
  )
    return deny("RECIPIENT_REQUIRED", 403);
  const readiness = receivingReadinessSchema.parse(context.readiness);
  if (
    context.recipientBinding.destinationVersion !== destinationVersion ||
    readiness.destinationVersion !== destinationVersion ||
    !readiness.observedAt ||
    !fresh(Date.parse(readiness.observedAt), now, freshnessMs)
  )
    return deny("DESTINATION_UNVERIFIED", 409);
  return Object.freeze({
    siteId: currentActor.siteId,
    accountId: id(context.accountId),
    accountReference: reference(context.recipientBinding.accountReference),
    environment: context.mode,
    bankReference: reference(context.bankReference),
    destinationVersion,
    amountCents,
    currency: "BRL",
  });
}

function feeObservation(
  value: unknown,
  scope: WithdrawalFeeScope,
  context: WithdrawalReservationContext,
  applicationEnvironment: string,
  now: number,
  freshnessMs: number,
): WithdrawalReservationSnapshot["feeQuote"] {
  try {
    const raw = record(value);
    if (
      Object.entries(scope).some(([key, expected]) => raw[key] !== expected) ||
      raw.verification !== "verified" ||
      (raw.feeSemantics !== undefined &&
        raw.feeSemantics !== "MAXIMUM" &&
        raw.feeSemantics !== "MAXIMUM_WITH_MINIMUM_NET") ||
      (raw.provenance !== "provider" && raw.provenance !== "simulation") ||
      (raw.provenance === "simulation" &&
        (scope.environment !== "sandbox" ||
          !context.isDemo ||
          applicationEnvironment === "production"))
    )
      return deny("FEE_QUOTE_UNAVAILABLE", 409);
    const feeCents = cents(raw.feeCents);
    const observed = time(raw.observedAt);
    const expiry = time(raw.expiresAt);
    if (
      BigInt(feeCents) >= BigInt(scope.amountCents) ||
      !fresh(observed, now, freshnessMs) ||
      expiry <= now ||
      expiry - observed > freshnessMs
    )
      return deny("FEE_QUOTE_UNAVAILABLE", 409);
    return Object.freeze({
      feeCents,
      policyVersion: id(raw.policyVersion),
      ...(raw.feeSemantics === "MAXIMUM" ||
      raw.feeSemantics === "MAXIMUM_WITH_MINIMUM_NET"
        ? {
            feeSemantics: raw.feeSemantics as
              | "MAXIMUM"
              | "MAXIMUM_WITH_MINIMUM_NET",
          }
        : {}),
      provenance: raw.provenance,
      observedAt: new Date(observed).toISOString(),
      expiresAt: new Date(expiry).toISOString(),
    });
  } catch {
    return deny("FEE_QUOTE_UNAVAILABLE", 409);
  }
}

export function captureWithdrawalPresentation(
  value: unknown,
  scope: WithdrawalFeeScope,
  context: WithdrawalReservationContext,
  operatorUserId: string,
  at: number,
  freshnessMs: number,
  _applicationEnvironment: string,
): WithdrawalConsentSnapshot["presentation"] {
  const raw = record(value);
  if (
    Object.entries(scope).some(([key, expected]) => raw[key] !== expected) ||
    raw.source !== "stored" ||
    raw.verification !== "verified" ||
    raw.operatorUserId !== operatorUserId ||
    raw.recipientReference !== context.recipientBinding?.recipientReference ||
    raw.provenance !== "provider"
  )
    return deny("DESTINATION_UNVERIFIED", 409);
  const times = [
    raw.evidenceObservedAt,
    raw.bankObservedAt,
    raw.operatorProfileUpdatedAt,
  ];
  for (let index = 0; index < times.length; index++) {
    time(times[index]);
    const micros = databaseTimestampEpochMicroseconds(times[index]);
    if (
      micros > BigInt(at) * 1000n ||
      (index < 2 && BigInt(at) * 1000n - micros > BigInt(freshnessMs) * 1000n)
    )
      return deny("DESTINATION_UNVERIFIED", 409);
  }
  return {
    ...scope,
    ...(raw.payout === undefined
      ? {}
      : { payout: readWithdrawalPayoutBinding(raw.payout) }),
    source: "stored",
    verification: "verified",
    provenance: raw.provenance as "provider" | "simulation",
    operatorUserId,
    recipientReference: reference(raw.recipientReference),
    destinationId: id(raw.destinationId),
    evidenceId: id(raw.evidenceId),
    verificationReference: reference(raw.verificationReference),
    evidenceObservedAt: canonicalStoredInstant(raw.evidenceObservedAt),
    bankObservedAt: canonicalStoredInstant(raw.bankObservedAt),
    operatorProfileUpdatedAt: canonicalStoredInstant(
      raw.operatorProfileUpdatedAt,
    ),
    maskedDestination: withdrawalPreviewSchema.shape.maskedDestination.parse(
      raw.maskedDestination,
    ),
    operatorDisplayName:
      withdrawalPreviewSchema.shape.operatorDisplayName.parse(
        raw.operatorDisplayName,
      ),
  };
}
export function sameWithdrawalConsentTerms(
  consent: WithdrawalConsentSnapshot,
  candidate: WithdrawalReservationSnapshot,
  presentation: WithdrawalConsentSnapshot["presentation"],
): boolean {
  return (
    candidate.intent.siteId === consent.preview.siteId &&
    candidate.requestId === consent.preview.requestId &&
    candidate.environment === consent.preview.mode &&
    candidate.accountId === consent.scope.accountId &&
    candidate.accountReference === consent.scope.accountReference &&
    candidate.bankReference === consent.scope.bankReference &&
    candidate.recipientReference === consent.recipientReference &&
    candidate.operatorUserId === consent.operatorUserId &&
    candidate.intent.amountCents === consent.preview.amountCents &&
    candidate.intent.feeCents === consent.preview.feeCents &&
    candidate.intent.netCents === consent.preview.netCents &&
    candidate.intent.destinationVersion ===
      consent.preview.destinationVersion &&
    candidate.feeQuote.policyVersion === consent.preview.policyVersion &&
    candidate.feeQuote.provenance === consent.feeQuote.provenance &&
    candidate.feeQuote.feeSemantics === consent.feeQuote.feeSemantics &&
    sameWithdrawalPayout(presentation.payout, consent.presentation.payout) &&
    presentation.destinationId === consent.presentation.destinationId &&
    presentation.maskedDestination === consent.preview.maskedDestination &&
    presentation.operatorDisplayName === consent.preview.operatorDisplayName &&
    presentation.operatorProfileUpdatedAt ===
      consent.presentation.operatorProfileUpdatedAt
  );
}

function balanceObservation(
  value: unknown,
  scope: WithdrawalFeeScope,
  now: number,
  freshnessMs: number,
): WithdrawalReservationSnapshot["balance"] {
  try {
    const raw = record(value);
    if (
      raw.source !== "provider" ||
      raw.provider !== "ASAAS" ||
      raw.siteId !== scope.siteId ||
      raw.accountBindingId !== scope.accountId ||
      raw.accountReference !== scope.accountReference ||
      raw.environment !== scope.environment ||
      raw.currency !== "BRL"
    )
      return deny("PROVIDER_BALANCE_UNAVAILABLE", 409);
    const observed = time(raw.observedAt);
    if (!fresh(observed, now, freshnessMs))
      return deny("PROVIDER_BALANCE_UNAVAILABLE", 409);
    return Object.freeze({
      balanceCents: cents(raw.balanceCents),
      observedAt: new Date(observed).toISOString(),
    });
  } catch {
    return deny("PROVIDER_BALANCE_UNAVAILABLE", 409);
  }
}

export function createWithdrawalReservationService(
  options: WithdrawalReservationOptions,
): WithdrawalReservationService {
  try {
    if (options.mode === "disabled")
      return {
        async createWithdrawal() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async readContext() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async createPreview() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async readRequest() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async confirmNew() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async recoverExisting() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
        async sealUncreatedRequest() {
          return deny("PROVIDER_MODE_UNAVAILABLE", 409);
        },
      };
    const mode = options.mode;
    const applicationEnvironment = options.applicationEnvironment;
    const liveDemoSiteId = options.liveDemoSiteId;
    if (
      (mode !== "sandbox" && mode !== "live") ||
      (mode === "live" && applicationEnvironment !== "production")
    )
      return deny("PROVIDER_MODE_UNAVAILABLE", 409);
    const maxAge = options.maxAuthAgeMs;
    const freshnessMs = options.freshnessMs;
    if (
      !["test", "development", "production"].includes(applicationEnvironment) ||
      [maxAge, freshnessMs].some(
        (v) => !Number.isSafeInteger(v) || v < 1 || v > 300_000,
      ) ||
      typeof options.now !== "function" ||
      typeof options.generateId !== "function" ||
      typeof options.loadContext !== "function" ||
      typeof options.feeQuotes?.quoteWithdrawal !== "function" ||
      typeof options.balance?.getBalance !== "function" ||
      typeof options.repository?.findByRequest !== "function" ||
      typeof options.repository?.reserveWithdrawal !== "function"
    )
      return deny("WITHDRAWAL_UNAVAILABLE");
    const now = options.now.bind(options);
    const generateId = options.generateId.bind(options);
    const loadContext = options.loadContext.bind(options);
    const quoteWithdrawal = options.feeQuotes.quoteWithdrawal.bind(
      options.feeQuotes,
    );
    const getBalance = options.balance.getBalance.bind(options.balance);
    const findByRequest = options.repository.findByRequest.bind(
      options.repository,
    );
    const reserveWithdrawal = options.repository.reserveWithdrawal.bind(
      options.repository,
    );
    const readRequest = options.repository.readRequest?.bind(
      options.repository,
    );
    const readContext = options.repository.readContext?.bind(
      options.repository,
    );
    const findConsent = options.repository.findConsent?.bind(
      options.repository,
    );
    const issuePreview = options.repository.issuePreview?.bind(
      options.repository,
    );
    const recover = options.repository.recoverWithdrawal?.bind(
      options.repository,
    );
    const seal = options.repository.sealUncreatedRequest?.bind(
      options.repository,
    );
    const loadPresentation = options.loadVerifiedPresentation?.bind(options);
    const readAttempt = (value: WithdrawalReadAttempt) => {
      const currentActor = actor(value.actor);
      eligible(value.access, currentActor);
      return {
        actor: currentActor,
        access: Object.freeze(siteAccessSchema.parse(value.access)),
      };
    };
    const protectedAttempt = (value: WithdrawalProtectedRequestAttempt) => {
      const selected = readAttempt(value);
      return {
        ...selected,
        requestId: id(value.requestId),
        recentAuth: captureProof(
          value.recentAuth,
          selected.actor,
          time(now()),
          maxAge,
        ),
      };
    };
    const safe = (error: unknown): never => {
      logWithdrawalFailure(error);
      if (error instanceof WithdrawalReservationServiceError)
        return deny(error.code, error.status);
      if (error instanceof FinancialAuthorizationError)
        throw new FinancialAuthorizationError(
          error.status,
          error.code,
          "Financial authorization denied",
        );
      if (error instanceof ReceivingReadinessServiceError)
        throw new ReceivingReadinessServiceError();
      return deny("WITHDRAWAL_UNAVAILABLE");
    };
    const service: WithdrawalReservationService = {
      async readContext(attempt) {
        try {
          const selected = readAttempt(attempt);
          if (!readContext) return deny("PROVIDER_MODE_UNAVAILABLE", 409);
          if (
            attempt.cursor !== undefined &&
            !/^[A-Za-z0-9._:-]{1,256}$/.test(attempt.cursor)
          )
            return deny("WITHDRAWAL_INVALID", 400);
          const result = withdrawalRequestContextSchema.parse(
            await readContext({
              ...selected,
              ...(attempt.cursor === undefined
                ? {}
                : { cursor: attempt.cursor }),
            }),
          );
          if (result.siteId !== selected.actor.siteId || result.mode !== mode)
            return deny("WITHDRAWAL_UNAVAILABLE");
          return result;
        } catch (error) {
          return safe(error);
        }
      },
      async readRequest(attempt) {
        try {
          const selected = {
            ...readAttempt(attempt),
            requestId: id(attempt.requestId),
          };
          if (!readRequest) return deny("PROVIDER_MODE_UNAVAILABLE", 409);
          const result = withdrawalRequestStatusSchema.parse(
            await readRequest(selected),
          );
          if (
            result.siteId !== selected.actor.siteId ||
            result.requestId !== selected.requestId ||
            result.mode !== mode
          )
            return deny("WITHDRAWAL_UNAVAILABLE");
          return result;
        } catch (error) {
          return safe(error);
        }
      },
      async createPreview(attempt) {
        try {
          const selected = readAttempt(attempt);
          const input = withdrawalPreviewInputSchema.safeParse(attempt.input);
          if (!input.success) return deny("WITHDRAWAL_INVALID", 400);
          const prior = await service.readRequest({
            ...selected,
            requestId: input.data.requestId,
          });
          if (
            prior.state !== "UNRESOLVED" ||
            prior.command !== null ||
            prior.observationOrder.recordUpdatedAtMicroseconds !== null
          ) {
            const amount =
              prior.state === "OPEN"
                ? prior.preview.amountCents
                : prior.command?.amountCents;
            if (amount !== input.data.amountCents)
              return deny("REQUEST_CONFLICT", 409);
            return prior;
          }
          if (prior.scopeRevision !== input.data.scopeRevision)
            return deny("REQUEST_CONFLICT", 409);
          if (!issuePreview || !loadPresentation)
            return deny("DESTINATION_UNVERIFIED", 409);
          let last = time(now());
          const clock = () => {
            const current = time(now());
            last = Math.max(last, current);
            return last;
          };
          const context = contextScope(
            await loadContext(selected.actor.siteId),
            selected.actor.siteId,
            mode,
            applicationEnvironment,
            liveDemoSiteId,
          );
          const at = clock();
          const binding = context.recipientBinding;
          const readiness = context.readiness;
          if (
            context.verification !== "verified" ||
            !binding ||
            binding.operatorUserId !== selected.actor.userId ||
            binding.siteId !== selected.actor.siteId ||
            !context.accountId ||
            !context.bankReference
          )
            return deny("RECIPIENT_REQUIRED", 403);
          if (
            readiness?.state !== "READY" ||
            !readiness.observedAt ||
            readiness.destinationVersion !== binding.destinationVersion ||
            !fresh(Date.parse(readiness.observedAt), at, freshnessMs)
          )
            return deny("DESTINATION_UNVERIFIED", 409);
          const scope: WithdrawalFeeScope = {
            siteId: selected.actor.siteId,
            accountId: context.accountId,
            accountReference: binding.accountReference,
            environment: mode,
            bankReference: context.bankReference,
            destinationVersion: binding.destinationVersion,
            amountCents: input.data.amountCents,
            currency: "BRL",
          };
          const feeValue = await quoteWithdrawal(scope);
          const fee = feeObservation(
            feeValue,
            scope,
            context,
            applicationEnvironment,
            clock(),
            freshnessMs,
          );
          const value = await loadPresentation(scope);
          const issued = clock();
          const presentation = captureWithdrawalPresentation(
            value,
            scope,
            context,
            selected.actor.userId,
            issued,
            freshnessMs,
            applicationEnvironment,
          );
          if (
            Date.parse(fee.expiresAt) <= issued ||
            !fresh(Date.parse(fee.observedAt), issued, freshnessMs)
          )
            return deny("FEE_QUOTE_UNAVAILABLE", 409);
          const snapshot = readWithdrawalConsentSnapshot({
            preview: {
              siteId: scope.siteId,
              requestId: input.data.requestId,
              mode,
              currency: "BRL",
              amountCents: scope.amountCents,
              feeCents: fee.feeCents,
              ...(fee.feeSemantics ? { feeSemantics: fee.feeSemantics } : {}),
              netCents: Number(
                BigInt(scope.amountCents) - BigInt(fee.feeCents),
              ),
              destinationVersion: scope.destinationVersion,
              maskedDestination: presentation.maskedDestination,
              ...(presentation.payout
                ? { payoutRecipientName: presentation.payout.ownerName }
                : {}),
              operatorDisplayName: presentation.operatorDisplayName,
              policyVersion: fee.policyVersion,
              issuedAt: new Date(issued).toISOString(),
              expiresAt: fee.expiresAt,
            },
            scope,
            operatorUserId: selected.actor.userId,
            recipientReference: binding.recipientReference,
            presentation,
            feeQuote: fee,
          });
          const result = withdrawalRequestStatusSchema.parse(
            await issuePreview(snapshot, input.data.scopeRevision, selected),
          );
          if (
            result.siteId !== scope.siteId ||
            result.requestId !== snapshot.preview.requestId ||
            result.mode !== mode ||
            (result.state === "OPEN" &&
              !isDeepStrictEqual(result.preview, snapshot.preview))
          )
            return deny("WITHDRAWAL_UNAVAILABLE");
          return result;
        } catch (error) {
          return safe(error);
        }
      },
      async confirmNew(attempt) {
        try {
          const selected = protectedAttempt(attempt);
          const current = await service.readRequest(selected);
          if (current.state === "EXISTING")
            return service.recoverExisting(selected);
          if (current.state !== "OPEN" || !findConsent)
            return deny("REQUEST_CONFLICT", 409);
          const consent = readWithdrawalConsentRecord(
            await findConsent(selected),
          );
          if (consent.state !== "OPEN") return deny("REQUEST_CONFLICT", 409);
          return service.createWithdrawal({
            ...selected,
            input: {
              requestId: current.requestId,
              amountCents: current.preview.amountCents,
              destinationVersion: current.preview.destinationVersion,
            },
            confirmation: {
              requestId: current.requestId,
              previewHash: consent.previewHash,
              requestRevision: "1",
            },
          });
        } catch (error) {
          return safe(error);
        }
      },
      async recoverExisting(attempt) {
        try {
          const selected = protectedAttempt(attempt);
          if (!recover) return deny("PROVIDER_MODE_UNAVAILABLE", 409);
          const record = readWithdrawalReservationRecord(
            await recover(selected),
          );
          if (
            record.snapshot.intent.siteId !== selected.actor.siteId ||
            record.snapshot.requestId !== selected.requestId ||
            record.snapshot.operatorUserId !== selected.actor.userId ||
            record.snapshot.environment !== mode
          )
            return deny("REQUEST_CONFLICT", 409);
          freshProof(selected.recentAuth, time(now()), maxAge);
          return record.intent;
        } catch (error) {
          return safe(error);
        }
      },
      async sealUncreatedRequest(attempt) {
        try {
          const selected = {
            ...readAttempt(attempt),
            requestId: id(attempt.requestId),
          };
          if (!seal) return deny("PROVIDER_MODE_UNAVAILABLE", 409);
          const result = withdrawalRequestStatusSchema.parse(
            await seal(selected),
          );
          if (
            result.siteId !== selected.actor.siteId ||
            result.requestId !== selected.requestId ||
            result.mode !== mode
          )
            return deny("WITHDRAWAL_UNAVAILABLE");
          return result;
        } catch (error) {
          return safe(error);
        }
      },
      async createWithdrawal(attempt) {
        try {
          const currentActor = actor(attempt.actor);
          eligible(attempt.access, currentActor);
          const access = siteAccessSchema.parse(attempt.access);
          const parsed = withdrawalReservationInputSchema.safeParse(
            attempt.input,
          );
          if (!parsed.success) return deny("WITHDRAWAL_INVALID", 400);
          const input = Object.freeze(parsed.data);
          let lastClock = -1;
          const clock = () => {
            const current = time(now());
            lastClock = Math.max(lastClock, current);
            return lastClock;
          };
          const proof = captureProof(
            attempt.recentAuth,
            currentActor,
            clock(),
            maxAge,
          );
          const requestIdentity = requestHash(
            {
              siteId: currentActor.siteId,
              amountCents: input.amountCents,
              destinationVersion: input.destinationVersion,
              mode,
            },
            input.requestId,
            currentActor.userId,
          );
          const checkRecord = (value: unknown, observedNow: number) => {
            const stored = readWithdrawalReservationRecord(value);
            if (
              stored.snapshot.intent.siteId !== currentActor.siteId ||
              stored.snapshot.requestId !== input.requestId ||
              Date.parse(stored.intent.updatedAt) > observedNow
            )
              return deny("WITHDRAWAL_UNAVAILABLE");
            if (stored.snapshot.requestHash !== requestIdentity)
              return deny("REQUEST_CONFLICT", 409);
            return stored;
          };
          const priorValue = await findByRequest(
            currentActor.siteId,
            input.requestId,
          );
          const lookedAt = clock();
          freshProof(proof, lookedAt, maxAge);
          const previous =
            priorValue === null ? null : checkRecord(priorValue, lookedAt);
          let snapshot = previous?.snapshot;
          let consent: WithdrawalConsentRecord | null = null;
          if (!snapshot) {
            if (!attempt.confirmation || !findConsent)
              return deny("REQUEST_CONFLICT", 409);
            const confirmation = exact(attempt.confirmation, [
              "requestId",
              "previewHash",
              "requestRevision",
            ]);
            consent = readWithdrawalConsentRecord(
              await findConsent({
                actor: currentActor,
                access,
                requestId: input.requestId,
              }),
            );
            if (consent.state === "COMMITTED")
              return service.recoverExisting({
                actor: currentActor,
                access,
                requestId: input.requestId,
                recentAuth: proof,
              });
            if (
              consent.state !== "OPEN" ||
              confirmation.requestId !== input.requestId ||
              confirmation.previewHash !== consent.previewHash ||
              confirmation.requestRevision !== "1" ||
              consent.snapshot.preview.siteId !== currentActor.siteId ||
              consent.snapshot.operatorUserId !== currentActor.userId ||
              consent.snapshot.preview.mode !== mode ||
              consent.snapshot.preview.amountCents !== input.amountCents ||
              consent.snapshot.preview.destinationVersion !==
                input.destinationVersion
            )
              return deny("REQUEST_CONFLICT", 409);
            if (Date.parse(consent.snapshot.preview.expiresAt) <= clock())
              return deny("PREVIEW_EXPIRED", 409);
            const context = contextScope(
              await loadContext(currentActor.siteId),
              currentActor.siteId,
              mode,
              applicationEnvironment,
              liveDemoSiteId,
            );
            const scope = receivingScope(
              context,
              currentActor,
              access,
              proof,
              clock(),
              maxAge,
              freshnessMs,
              input.amountCents,
              input.destinationVersion,
            );
            const feeValue = await quoteWithdrawal(scope);
            const quotedAt = clock();
            freshProof(proof, quotedAt, maxAge);
            const fee = feeObservation(
              feeValue,
              scope,
              context,
              applicationEnvironment,
              quotedAt,
              freshnessMs,
            );
            const balanceValue = await getBalance(scope);
            const created = clock();
            freshProof(proof, created, maxAge);
            if (
              !fresh(Date.parse(fee.observedAt), created, freshnessMs) ||
              Date.parse(fee.expiresAt) <= created
            )
              return deny("FEE_QUOTE_UNAVAILABLE", 409);
            const balance = balanceObservation(
              balanceValue,
              scope,
              created,
              freshnessMs,
            );
            if (balance.balanceCents < input.amountCents)
              return deny("INSUFFICIENT_FUNDS", 409);
            const createdAt = new Date(created).toISOString();
            const intent: WithdrawalIntent = {
              id: id(generateId("withdrawal")),
              siteId: currentActor.siteId,
              amountCents: input.amountCents,
              feeCents: fee.feeCents,
              ...(fee.feeSemantics ? { feeSemantics: fee.feeSemantics } : {}),
              netCents: Number(
                BigInt(input.amountCents) - BigInt(fee.feeCents),
              ),
              currency: "BRL",
              destinationVersion: input.destinationVersion,
              state: "REQUESTED",
              createdAt,
              updatedAt: createdAt,
              mode,
            };
            snapshot = readWithdrawalReservationSnapshot({
              intent,
              requestId: input.requestId,
              accountId: scope.accountId,
              operatorUserId: currentActor.userId,
              accountReference: scope.accountReference,
              recipientReference: context.recipientBinding?.recipientReference,
              bankReference: scope.bankReference,
              environment: mode,
              operationId: id(generateId("operation")),
              requestHash: requestIdentity,
              authenticationAuditHash: hash([
                "withdrawal.authentication.v1",
                currentActor.userId,
                currentActor.siteId,
                currentActor.sessionId,
                proof.proofKind,
                proof.authenticatedAt?.toISOString(),
                proof.expiresAt?.toISOString(),
              ]),
              feeQuote: fee,
              balance,
            });
            if (!loadPresentation) return deny("DESTINATION_UNVERIFIED", 409);
            const presentation = captureWithdrawalPresentation(
              await loadPresentation(scope),
              scope,
              context,
              currentActor.userId,
              clock(),
              freshnessMs,
              applicationEnvironment,
            );
            if (
              !sameWithdrawalConsentTerms(
                consent.snapshot,
                snapshot,
                presentation,
              )
            )
              return deny("REQUEST_CONFLICT", 409);
            if (Date.parse(consent.snapshot.preview.expiresAt) <= clock())
              return deny("PREVIEW_EXPIRED", 409);
          }
          const candidate = snapshot;
          let authorizedRecord: WithdrawalReservationRecord | null = null;
          let authorizedReplay = false;
          const committed = await reserveWithdrawal(
            candidate,
            async (state) => {
              authorizedRecord = null;
              authorizedReplay = false;
              const locked = record(state);
              const session = actor(locked.currentSession);
              if (!isDeepStrictEqual(session, currentActor))
                return deny("MEMBERSHIP_DENIED", 403);
              eligible(locked.access, currentActor);
              const current = clock();
              freshProof(proof, current, maxAge);
              if (locked.existingReservation !== null) {
                const existing = checkRecord(
                  locked.existingReservation,
                  current,
                );
                if (
                  previous &&
                  !isDeepStrictEqual(existing.snapshot, previous.snapshot)
                )
                  return deny("WITHDRAWAL_UNAVAILABLE");
                authorizedRecord = existing;
                authorizedReplay = true;
                return;
              }
              if (previous) return deny("WITHDRAWAL_UNAVAILABLE");
              const lockedContext = contextScope(
                locked.context,
                currentActor.siteId,
                mode,
                applicationEnvironment,
                liveDemoSiteId,
              );
              const scope = receivingScope(
                lockedContext,
                currentActor,
                locked.access,
                proof,
                current,
                maxAge,
                freshnessMs,
                input.amountCents,
                input.destinationVersion,
              );
              if (
                scope.accountId !== candidate.accountId ||
                scope.accountReference !== candidate.accountReference ||
                scope.bankReference !== candidate.bankReference ||
                lockedContext.recipientBinding?.recipientReference !==
                  candidate.recipientReference
              )
                return deny("DESTINATION_UNVERIFIED", 409);
              if (
                !fresh(
                  Date.parse(candidate.feeQuote.observedAt),
                  current,
                  freshnessMs,
                ) ||
                Date.parse(candidate.feeQuote.expiresAt) <= current
              )
                return deny("FEE_QUOTE_UNAVAILABLE", 409);
              if (
                candidate.feeQuote.provenance === "simulation" &&
                (!lockedContext.isDemo ||
                  applicationEnvironment === "production")
              )
                return deny("FEE_QUOTE_UNAVAILABLE", 409);
              if (
                !fresh(
                  Date.parse(candidate.balance.observedAt),
                  current,
                  freshnessMs,
                )
              )
                return deny("PROVIDER_BALANCE_UNAVAILABLE", 409);
              if (
                !Number.isSafeInteger(locked.unresolvedFinancialEventCount) ||
                (locked.unresolvedFinancialEventCount as number) < 0
              )
                return deny("WITHDRAWAL_UNAVAILABLE");
              if (locked.unresolvedFinancialEventCount !== 0)
                return deny("FINANCIAL_EVENTS_UNRESOLVED", 409);
              if (
                !Number.isSafeInteger(
                  locked.balanceEffectsAfterObservationCount,
                ) ||
                (locked.balanceEffectsAfterObservationCount as number) < 0
              )
                return deny("WITHDRAWAL_UNAVAILABLE");
              if (locked.balanceEffectsAfterObservationCount !== 0)
                return deny("PROVIDER_BALANCE_UNAVAILABLE", 409);
              if (typeof locked.heldCents !== "bigint" || locked.heldCents < 0n)
                return deny("WITHDRAWAL_UNAVAILABLE");
              if (
                BigInt(candidate.balance.balanceCents) - locked.heldCents <
                BigInt(candidate.intent.amountCents)
              )
                return deny("INSUFFICIENT_FUNDS", 409);
              authorizedRecord = {
                snapshot: candidate,
                intent: candidate.intent,
              };
            },
            Object.freeze({
              actor: Object.freeze({ ...currentActor }),
              recentAuth: Object.freeze({
                ...proof,
                authenticatedAt: new Date(time(proof.authenticatedAt)),
                expiresAt: new Date(time(proof.expiresAt)),
              }),
            }),
            consent
              ? {
                  requestId: input.requestId,
                  previewHash: consent.previewHash,
                  requestRevision: "1",
                }
              : undefined,
          );
          const finishedAt = clock();
          freshProof(proof, finishedAt, maxAge);
          if (!authorizedRecord) return deny("WITHDRAWAL_UNAVAILABLE");
          // This uncertainty never releases the already committed reservation.
          if (
            !authorizedReplay &&
            (!fresh(
              Date.parse(candidate.balance.observedAt),
              finishedAt,
              freshnessMs,
            ) ||
              !fresh(
                Date.parse(candidate.feeQuote.observedAt),
                finishedAt,
                freshnessMs,
              ) ||
              Date.parse(candidate.feeQuote.expiresAt) <= finishedAt)
          )
            return deny("WITHDRAWAL_UNAVAILABLE");
          const result = checkRecord(committed, finishedAt);
          if (!isDeepStrictEqual(result, authorizedRecord))
            return deny("WITHDRAWAL_UNAVAILABLE");
          return result.intent;
        } catch (error) {
          if (error instanceof WithdrawalReservationServiceError)
            throw new WithdrawalReservationServiceError(
              error.status,
              error.code,
            );
          if (error instanceof FinancialAuthorizationError)
            throw new FinancialAuthorizationError(
              error.status,
              error.code,
              "Financial authorization denied",
            );
          if (error instanceof ReceivingReadinessServiceError)
            throw new ReceivingReadinessServiceError();
          return deny("WITHDRAWAL_UNAVAILABLE");
        }
      },
    };
    return service;
  } catch (error) {
    if (error instanceof WithdrawalReservationServiceError)
      throw new WithdrawalReservationServiceError(error.status, error.code);
    return deny("WITHDRAWAL_UNAVAILABLE");
  }
}
