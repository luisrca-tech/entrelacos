import {
  type ReceivingReadiness,
  receivingReadinessSchema,
} from "@entrelacos/contracts";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";

export interface ReceivingProviderBinding {
  siteId: string;
  provider: string;
  operatorReference: string;
  environment: "sandbox" | "live";
  accountReference: string | null;
  recipientReference: string | null;
  destinationVersion: number | null;
  bankReference: string | null;
}

export interface ReceivingEvidence extends ReceivingProviderBinding {
  verification: "verified" | "unverified";
  provenance: "provider" | "simulation";
  accountState:
    | "onboarding"
    | "under_review"
    | "approved"
    | "blocked"
    | "suspended";
  bankState: "pending" | "verified" | "rejected";
  observedAt: Date | null;
  bankObservedAt: Date | null;
  capabilities: { receiving: boolean; withdrawal: boolean };
  commercialEnabled: boolean;
}

// Only server-loaded bindings and evidence may reach this evaluation boundary.
export interface ReceivingReadinessInput extends LiveSitePolicy {
  siteId: string;
  isDemo: boolean;
  environment: "development" | "test" | "production";
  mode: ReceivingReadiness["mode"];
  providerBinding: ReceivingProviderBinding | null;
  evidence: ReceivingEvidence | null;
  now: Date;
  freshnessMs: number;
}

export class ReceivingReadinessServiceError extends Error {
  readonly status = 409;
  readonly code = "RECEIVING_NOT_READY";
  readonly title = "Receiving is not ready";

  constructor() {
    super("Receiving is not ready");
    this.name = "ReceivingReadinessServiceError";
  }
}

function observationTime(value: Date | null, now: number): number | null {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isFinite(time) && time <= now ? time : null;
}

export function createDefaultReceivingReadiness(
  siteId: string,
): ReceivingReadiness {
  return {
    siteId,
    state: "NOT_CONFIGURED",
    reason: "NOT_CONFIGURED",
    observedAt: null,
    destinationVersion: null,
    catalogEligible: false,
    mode: "disabled",
  };
}

export function evaluateReceivingReadiness(
  input: ReceivingReadinessInput,
): ReceivingReadiness {
  const { providerBinding, evidence } = input;
  const version = providerBinding?.destinationVersion;
  const projection: ReceivingReadiness = {
    ...createDefaultReceivingReadiness(input.siteId),
    mode:
      input.mode === "sandbox" || input.mode === "live"
        ? input.mode
        : "disabled",
    destinationVersion:
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0
        ? version
        : null,
  };
  const deny = (
    state: ReceivingReadiness["state"],
    reason: NonNullable<ReceivingReadiness["reason"]>,
  ): ReceivingReadiness => ({ ...projection, state, reason });

  if (projection.mode === "disabled") {
    return deny("BLOCKED", "PROVIDER_DISABLED");
  }
  if (
    projection.mode === "live" &&
    !allowsLiveSite({ ...input, applicationEnvironment: input.environment })
  ) {
    return deny("BLOCKED", "ENVIRONMENT_MISMATCH");
  }
  if (!providerBinding) {
    return projection;
  }
  if (
    providerBinding.siteId !== input.siteId ||
    !providerBinding.provider.trim() ||
    !providerBinding.operatorReference.trim() ||
    providerBinding.environment !== input.mode ||
    !["development", "test", "production"].includes(input.environment) ||
    (input.environment === "production" && input.mode !== "live")
  ) {
    return deny("BLOCKED", "ENVIRONMENT_MISMATCH");
  }
  if (
    !providerBinding.accountReference?.trim() ||
    !providerBinding.recipientReference?.trim()
  ) {
    return deny("ONBOARDING", "ONBOARDING_REQUIRED");
  }
  if (
    !providerBinding.bankReference?.trim() ||
    projection.destinationVersion === null
  ) {
    return deny("BANK_VALIDATION_PENDING", "BANK_VERIFICATION_REQUIRED");
  }
  if (!evidence) {
    return deny("ONBOARDING", "ONBOARDING_REQUIRED");
  }
  if (
    evidence.siteId !== input.siteId ||
    evidence.provider !== providerBinding.provider ||
    evidence.operatorReference !== providerBinding.operatorReference ||
    evidence.environment !== providerBinding.environment ||
    evidence.accountReference !== providerBinding.accountReference ||
    evidence.recipientReference !== providerBinding.recipientReference ||
    (evidence.provenance !== "provider" &&
      (evidence.provenance !== "simulation" ||
        input.mode !== "sandbox" ||
        input.environment === "production" ||
        input.isDemo !== true))
  ) {
    return deny("BLOCKED", "ENVIRONMENT_MISMATCH");
  }
  if (
    evidence.destinationVersion !== providerBinding.destinationVersion ||
    evidence.bankReference !== providerBinding.bankReference
  ) {
    return deny("BLOCKED", "DESTINATION_CHANGED");
  }
  const now = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const observedAt = observationTime(evidence.observedAt, now);
  if (
    evidence.verification !== "verified" ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(input.freshnessMs) ||
    input.freshnessMs <= 0 ||
    observedAt === null
  ) {
    return deny("BLOCKED", "EVIDENCE_STALE");
  }
  projection.observedAt = new Date(observedAt).toISOString();
  if (now - observedAt > input.freshnessMs) {
    return deny("BLOCKED", "EVIDENCE_STALE");
  }
  if (
    evidence.accountState === "blocked" ||
    evidence.accountState === "suspended"
  ) {
    return deny("BLOCKED", "ACCOUNT_BLOCKED");
  }
  if (evidence.accountState === "onboarding") {
    return deny("ONBOARDING", "ONBOARDING_REQUIRED");
  }
  if (evidence.accountState !== "approved") {
    return deny("UNDER_REVIEW", "ACCOUNT_UNDER_REVIEW");
  }
  if (evidence.bankState !== "verified") {
    return deny("BANK_VALIDATION_PENDING", "BANK_VERIFICATION_REQUIRED");
  }
  const bankObservedAt = observationTime(evidence.bankObservedAt, now);
  if (bankObservedAt === null) {
    projection.observedAt = null;
    return deny("BLOCKED", "EVIDENCE_STALE");
  }
  // Account synchronization cannot renew older bank-verification evidence.
  projection.observedAt = new Date(
    Math.min(observedAt, bankObservedAt),
  ).toISOString();
  if (now - bankObservedAt > input.freshnessMs) {
    return deny("BLOCKED", "EVIDENCE_STALE");
  }
  if (evidence.commercialEnabled !== true) {
    return deny("BLOCKED", "PROVIDER_DISABLED");
  }
  if (
    evidence.capabilities?.receiving !== true ||
    evidence.capabilities?.withdrawal !== true
  ) {
    return deny("BLOCKED", "CAPABILITY_UNAVAILABLE");
  }
  return {
    ...projection,
    state: "READY",
    reason: null,
    catalogEligible: true,
  };
}

// Validate only authoritative server projections; a DTO is not provider proof.
export function assertReceivingReady(
  projection: unknown,
): asserts projection is ReceivingReadiness {
  const result = receivingReadinessSchema.safeParse(projection);
  if (!result.success || result.data.state !== "READY") {
    throw new ReceivingReadinessServiceError();
  }
}
