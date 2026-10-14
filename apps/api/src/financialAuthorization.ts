import {
  type ReceivingReadiness,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { assertReceivingReady } from "./receivingReadiness";

export interface FinancialActor {
  userId: string;
  siteId: string;
  sessionId: string;
}

export interface FinancialRecipientBinding {
  siteId: string;
  operatorUserId: string;
  environment: Exclude<ReceivingReadiness["mode"], "disabled">;
  accountReference: string;
  recipientReference: string;
  destinationVersion: number;
}

export interface RecentFinancialAuthenticationEvidence {
  userId: string;
  siteId: string;
  sessionId: string;
  proofKind: "PASSWORD_REAUTHENTICATION" | "MFA_REAUTHENTICATION";
  verification: "verified" | "unverified";
  provenance: "backend";
  authenticatedAt: Date | null;
  expiresAt: Date | null;
}

// Every field is server-resolved; session creation and browser proofs are invalid.
export interface RecipientFinancialActionInput {
  action: "CONFIGURE_RECEIVING" | "REQUEST_WITHDRAWAL";
  siteId: string;
  environment: FinancialRecipientBinding["environment"];
  access: unknown;
  actor: FinancialActor | null;
  recipientBinding: FinancialRecipientBinding | null;
  recentAuth: RecentFinancialAuthenticationEvidence | null;
  readiness?: ReceivingReadiness | null;
  now: Date;
  maxAuthAgeMs: number;
}

export class FinancialAuthorizationError extends Error {
  constructor(
    readonly status: 403 | 409,
    readonly code:
      | "MEMBERSHIP_DENIED"
      | "RECIPIENT_REQUIRED"
      | "RECENT_AUTH_REQUIRED"
      | "DESTINATION_UNVERIFIED",
    readonly title: string,
  ) {
    super(title);
    this.name = "FinancialAuthorizationError";
  }
}

function reject(
  code: FinancialAuthorizationError["code"],
  title: string,
): never {
  throw new FinancialAuthorizationError(
    code === "DESTINATION_UNVERIFIED" ? 409 : 403,
    code,
    title,
  );
}

// Access must be freshly resolved from active membership, never a browser DTO.
function selectedSiteAdmin(access: unknown, siteId: string): SiteAccess {
  const result = siteAccessSchema.safeParse(access);
  if (
    !result.success ||
    result.data.siteId !== siteId ||
    result.data.membershipRole !== "SITE_ADMIN" ||
    result.data.membershipId === null
  ) {
    return reject("MEMBERSHIP_DENIED", "Financial membership denied");
  }
  return result.data;
}

function hasReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertFinancialReadAccess(
  access: unknown,
  siteId: string,
): asserts access is SiteAccess {
  const selected = selectedSiteAdmin(access, siteId);
  if (!selected.capabilities.readFinance) {
    reject("MEMBERSHIP_DENIED", "Financial membership denied");
  }
}

export function assertRecipientFinancialAction(
  input: RecipientFinancialActionInput,
): void {
  const access = selectedSiteAdmin(input.access, input.siteId);
  const actor = input.actor;
  if (
    !actor ||
    actor.userId !== access.userId ||
    actor.siteId !== input.siteId ||
    (input.action !== "CONFIGURE_RECEIVING" &&
      input.action !== "REQUEST_WITHDRAWAL") ||
    (input.action === "CONFIGURE_RECEIVING" &&
      !access.capabilities.configureReceiving) ||
    (input.action === "REQUEST_WITHDRAWAL" && !access.capabilities.readFinance)
  ) {
    reject("MEMBERSHIP_DENIED", "Financial membership denied");
  }
  const binding = input.recipientBinding;
  if (
    !binding ||
    binding.siteId !== input.siteId ||
    binding.operatorUserId !== actor.userId ||
    !hasReference(binding.accountReference) ||
    !hasReference(binding.recipientReference)
  ) {
    reject("RECIPIENT_REQUIRED", "Designated financial recipient required");
  }
  if (
    (input.environment !== "sandbox" && input.environment !== "live") ||
    binding.environment !== input.environment ||
    !Number.isSafeInteger(binding.destinationVersion) ||
    binding.destinationVersion <= 0
  ) {
    reject("DESTINATION_UNVERIFIED", "Financial destination is unverified");
  }
  const proof = input.recentAuth;
  const now = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const authenticatedAt =
    proof?.authenticatedAt instanceof Date
      ? proof.authenticatedAt.getTime()
      : Number.NaN;
  const expiresAt =
    proof?.expiresAt instanceof Date ? proof.expiresAt.getTime() : Number.NaN;
  if (
    !proof ||
    !hasReference(actor.sessionId) ||
    proof.userId !== actor.userId ||
    proof.siteId !== input.siteId ||
    proof.sessionId !== actor.sessionId ||
    proof.provenance !== "backend" ||
    proof.verification !== "verified" ||
    (proof.proofKind !== "PASSWORD_REAUTHENTICATION" &&
      proof.proofKind !== "MFA_REAUTHENTICATION") ||
    !Number.isFinite(now) ||
    !Number.isFinite(authenticatedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isSafeInteger(input.maxAuthAgeMs) ||
    input.maxAuthAgeMs <= 0 ||
    authenticatedAt > now ||
    now - authenticatedAt > input.maxAuthAgeMs ||
    expiresAt <= now
  ) {
    reject("RECENT_AUTH_REQUIRED", "Verified recent authentication required");
  }
  if (input.action === "CONFIGURE_RECEIVING") return;

  // This evidence conjunction grants the action; the operational flag never does.
  assertReceivingReady(input.readiness);
  if (
    input.readiness.siteId !== input.siteId ||
    input.readiness.mode !== binding.environment ||
    input.readiness.destinationVersion !== binding.destinationVersion
  ) {
    reject("DESTINATION_UNVERIFIED", "Financial destination is unverified");
  }
}
