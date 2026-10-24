import type { ReceivingReadiness } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  site,
} from "@entrelacos/database/schema";
import { and, desc, eq } from "drizzle-orm";
import type { GiftQuoteReceivingContext } from "./giftQuotes";
import type { LiveSitePolicy } from "./liveSitePolicy";
import {
  createDefaultReceivingReadiness,
  evaluateReceivingReadiness,
  type ReceivingEvidence,
} from "./receivingReadiness";

export type ReceivingDatabase = Pick<DatabaseConnection["db"], "transaction">;
export type ReceivingTransaction = Parameters<
  Parameters<DatabaseConnection["db"]["transaction"]>[0]
>[0];

// Configuration and stored evidence are supplied only by the server.
export interface ReceivingRepositoryOptions extends LiveSitePolicy {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  freshnessMs: number;
  now?: () => Date;
  refresh?: (siteId: string) => Promise<void>;
}

function receivingEnabled(
  options: ReceivingRepositoryOptions | undefined,
): options is ReceivingRepositoryOptions & { mode: "sandbox" | "live" } {
  return options?.mode === "sandbox" || options?.mode === "live";
}

export class ReceivingRepositoryServiceError extends Error {
  readonly status = 503;
  readonly code = "SERVICE_UNAVAILABLE";
  readonly title = "Receiving status unavailable";

  constructor() {
    super("Receiving status unavailable");
    this.name = "ReceivingRepositoryServiceError";
  }
}

function hasReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableReference(value: unknown): string | null {
  return hasReference(value) ? value : null;
}

function sameScope(
  row: { siteId: string; accountId: string; environment: string },
  siteId: string,
  accountId: string,
  environment: string,
): boolean {
  return (
    row.siteId === siteId &&
    row.accountId === accountId &&
    row.environment === environment
  );
}

function accountState(value: string): ReceivingEvidence["accountState"] {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "UNDER_REVIEW":
      return "under_review";
    case "BLOCKED":
      return "blocked";
    case "SUSPENDED":
      return "suspended";
    default:
      return "onboarding";
  }
}

function bankState(value: string): ReceivingEvidence["bankState"] {
  return value === "VERIFIED"
    ? "verified"
    : value === "REJECTED"
      ? "rejected"
      : "pending";
}

function observationTime(value: Date | null, now: Date): number | null {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  const nowTime = now instanceof Date ? now.getTime() : Number.NaN;
  return Number.isFinite(time) && Number.isFinite(nowTime) && time <= nowTime
    ? time
    : null;
}

function accountObservation(
  current: Date | null,
  proof: Date | null,
  now: Date,
): Date | null {
  const currentTime = observationTime(current, now);
  const proofTime = observationTime(proof, now);
  // Both independent observations are required; the older one governs freshness.
  return currentTime !== null && proofTime !== null
    ? new Date(Math.min(currentTime, proofTime))
    : null;
}

// Internal context contains stored provider references; HTTP returns only readiness.
// Publication, lifecycle and contract-term eligibility remain the catalog boundary's responsibility.
// The caller owns transaction isolation and locks; this reader never nests a transaction.
export async function loadReceivingContextInTransaction(
  tx: ReceivingTransaction,
  siteId: string,
  options?: ReceivingRepositoryOptions,
): Promise<GiftQuoteReceivingContext | null> {
  if (!receivingEnabled(options)) return null;
  const {
    mode,
    applicationEnvironment,
    freshnessMs,
    now: clock,
    liveDemoSiteId,
  } = options;
  try {
    const [storedSite] = await tx
      .select({ id: site.id, isDemo: site.isDemo })
      .from(site)
      .where(eq(site.id, siteId))
      .limit(1);
    if (
      !storedSite ||
      storedSite.id !== siteId ||
      typeof storedSite.isDemo !== "boolean"
    )
      return null;
    const context: GiftQuoteReceivingContext = {
      isDemo: storedSite.isDemo,
      ...(liveDemoSiteId === undefined
        ? {}
        : { liveDemoSiteId: liveDemoSiteId }),
      environment: applicationEnvironment,
      mode,
      freshnessMs,
      providerBinding: null,
      evidence: null,
    };
    const [account] = await tx
      .select({
        id: receivingAccount.id,
        siteId: receivingAccount.siteId,
        environment: receivingAccount.environment,
        provider: receivingAccount.provider,
        operatorUserId: receivingAccount.operatorUserId,
        operatorReference: receivingAccount.operatorReference,
        accountReference: receivingAccount.accountReference,
        recipientReference: receivingAccount.recipientReference,
        providerAccountState: receivingAccount.providerAccountState,
        receivingCapability: receivingAccount.receivingCapability,
        withdrawalCapability: receivingAccount.withdrawalCapability,
        commercialEnabled: receivingAccount.commercialEnabled,
        isCurrent: receivingAccount.isCurrent,
        observedAt: receivingAccount.observedAt,
      })
      .from(receivingAccount)
      .where(
        and(
          eq(receivingAccount.siteId, siteId),
          eq(receivingAccount.environment, mode),
          eq(receivingAccount.isCurrent, true),
        ),
      )
      .limit(1);
    if (
      !account ||
      !hasReference(account.id) ||
      account.siteId !== siteId ||
      account.environment !== mode ||
      account.isCurrent !== true ||
      !hasReference(account.provider) ||
      !hasReference(account.operatorUserId) ||
      !hasReference(account.operatorReference)
    )
      return context;
    const [destination] = await tx
      .select({
        siteId: receivingDestination.siteId,
        accountId: receivingDestination.accountId,
        environment: receivingDestination.environment,
        version: receivingDestination.version,
        bankReference: receivingDestination.bankReference,
        bankState: receivingDestination.bankState,
        isCurrent: receivingDestination.isCurrent,
      })
      .from(receivingDestination)
      .where(
        and(
          eq(receivingDestination.siteId, siteId),
          eq(receivingDestination.accountId, account.id),
          eq(receivingDestination.environment, mode),
          eq(receivingDestination.isCurrent, true),
        ),
      )
      .limit(1);
    const matchedDestination =
      destination &&
      sameScope(destination, siteId, account.id, mode) &&
      destination.isCurrent === true &&
      Number.isSafeInteger(destination.version) &&
      destination.version > 0 &&
      destination.version <= 2147483647
        ? destination
        : null;
    context.providerBinding = {
      siteId: account.siteId,
      provider: account.provider,
      operatorReference: account.operatorReference,
      environment: account.environment,
      accountReference: nullableReference(account.accountReference),
      recipientReference: nullableReference(account.recipientReference),
      destinationVersion: matchedDestination?.version ?? null,
      bankReference: nullableReference(matchedDestination?.bankReference),
    };
    if (!matchedDestination) return context;
    const [proof, previousProof] = await tx
      .select({
        id: receivingVerificationEvidence.id,
        createdAt: receivingVerificationEvidence.createdAt,
        siteId: receivingVerificationEvidence.siteId,
        accountId: receivingVerificationEvidence.accountId,
        environment: receivingVerificationEvidence.environment,
        destinationVersion: receivingVerificationEvidence.destinationVersion,
        operatorReference: receivingVerificationEvidence.operatorReference,
        accountReference: receivingVerificationEvidence.accountReference,
        recipientReference: receivingVerificationEvidence.recipientReference,
        bankReference: receivingVerificationEvidence.bankReference,
        verificationStatus: receivingVerificationEvidence.verificationStatus,
        verificationReference:
          receivingVerificationEvidence.verificationReference,
        provenance: receivingVerificationEvidence.provenance,
        providerAccountState:
          receivingVerificationEvidence.providerAccountState,
        bankState: receivingVerificationEvidence.bankState,
        receivingCapability: receivingVerificationEvidence.receivingCapability,
        withdrawalCapability:
          receivingVerificationEvidence.withdrawalCapability,
        commercialEnabled: receivingVerificationEvidence.commercialEnabled,
        observedAt: receivingVerificationEvidence.observedAt,
        bankObservedAt: receivingVerificationEvidence.bankObservedAt,
      })
      .from(receivingVerificationEvidence)
      .where(
        and(
          eq(receivingVerificationEvidence.siteId, siteId),
          eq(receivingVerificationEvidence.accountId, account.id),
          eq(receivingVerificationEvidence.environment, mode),
          eq(
            receivingVerificationEvidence.destinationVersion,
            matchedDestination.version,
          ),
        ),
      )
      .orderBy(
        desc(receivingVerificationEvidence.createdAt),
        desc(receivingVerificationEvidence.id),
      )
      .limit(2);
    if (
      !proof ||
      !hasReference(proof.id) ||
      !sameScope(proof, siteId, account.id, mode) ||
      proof.destinationVersion !== matchedDestination.version ||
      (proof.provenance !== "PROVIDER" && proof.provenance !== "SIMULATION")
    )
      return context;
    const observedNow = clock?.() ?? new Date();
    const createdAt = observationTime(proof.createdAt, observedNow);
    const previousCreatedAt = previousProof
      ? observationTime(previousProof.createdAt, observedNow)
      : null;
    // Equal decoded timestamps cannot establish which proof supersedes the other.
    if (
      createdAt === null ||
      (previousProof &&
        (previousCreatedAt === null || previousCreatedAt >= createdAt))
    )
      return context;
    context.evidence = {
      siteId: proof.siteId,
      provider: account.provider,
      operatorReference: nullableReference(proof.operatorReference) ?? "",
      environment: proof.environment,
      accountReference: nullableReference(proof.accountReference),
      recipientReference: nullableReference(proof.recipientReference),
      destinationVersion: proof.destinationVersion,
      bankReference: nullableReference(proof.bankReference),
      verification:
        proof.verificationStatus === "VERIFIED" &&
        hasReference(proof.verificationReference)
          ? "verified"
          : "unverified",
      provenance: proof.provenance === "PROVIDER" ? "provider" : "simulation",
      accountState: accountState(
        account.providerAccountState === "APPROVED"
          ? proof.providerAccountState
          : account.providerAccountState,
      ),
      bankState: bankState(
        matchedDestination.bankState === "VERIFIED"
          ? proof.bankState
          : matchedDestination.bankState,
      ),
      observedAt: accountObservation(
        account.observedAt,
        proof.observedAt,
        observedNow,
      ),
      bankObservedAt: proof.bankObservedAt,
      capabilities: {
        receiving:
          account.receivingCapability === true &&
          proof.receivingCapability === true,
        withdrawal:
          account.withdrawalCapability === true &&
          proof.withdrawalCapability === true,
      },
      commercialEnabled:
        account.commercialEnabled === true && proof.commercialEnabled === true,
    };
    return context;
  } catch {
    // Driver errors can carry SQL, identifiers or secrets in nested causes.
    throw new ReceivingRepositoryServiceError();
  }
}

export async function loadReceivingContext(
  db: ReceivingDatabase,
  siteId: string,
  options?: ReceivingRepositoryOptions,
): Promise<GiftQuoteReceivingContext | null> {
  if (!receivingEnabled(options)) return null;
  try {
    try {
      await options.refresh?.(siteId);
    } catch {
      /* Stored proof freshness still governs eligibility. */
    }
    return await db.transaction(
      (tx) => loadReceivingContextInTransaction(tx, siteId, options),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch {
    throw new ReceivingRepositoryServiceError();
  }
}

export async function readReceivingReadiness(
  db: ReceivingDatabase,
  siteId: string,
  options?: ReceivingRepositoryOptions,
): Promise<ReceivingReadiness> {
  const context = await loadReceivingContext(db, siteId, options);
  return context
    ? evaluateReceivingReadiness({
        ...context,
        siteId,
        now: options?.now?.() ?? new Date(),
      })
    : createDefaultReceivingReadiness(siteId);
}
