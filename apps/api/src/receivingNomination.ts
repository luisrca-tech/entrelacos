import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  giftQuoteSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { ADMIN_ABSOLUTE_TIMEOUT_MS } from "./authHttp";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import type { ProviderCredentialEnvelope } from "./providerCredentials";

const NominationPromise = Promise;
const nominationPromiseThen = Promise.prototype.then;
const nominationPromiseApply = Reflect.apply;
const isNominationPromise = types.isPromise;

// Metadata failure alone never completes ownership of the original native operation.
export function observeNominationSettlement<T>(
  operation: Promise<T>,
): Promise<Readonly<{ value: T }>> {
  return new NominationPromise((resolve, reject) => {
    try {
      if (!isNominationPromise(operation)) return;
      nominationPromiseApply(nominationPromiseThen, operation, [
        (value: T) => {
          resolve(Object.freeze({ value }));
        },
        (reason: unknown) => {
          reject(reason);
        },
      ]);
    } catch {
      // Constructor/species attachment failure leaves ownership unresolved.
      // Without an independent completion port there is no finite drain proof.
    }
  });
}

export interface ReceivingNominationInput {
  requestId: string;
  confirmSelfAsRecipient: true;
  policyVersion: string;
}

export interface ReceivingNominationScope {
  siteId: string;
  operatorUserId: string;
  environment: "sandbox" | "live";
}
export interface ReceivingNominationConfiguration {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  policyVersion: string;
  requestIdentityVersion: "nr1";
}
export function deriveReceivingNominationRequestId(
  scope: ReceivingNominationScope,
): string {
  const value = exactRecord(scope, ["siteId", "operatorUserId", "environment"]);
  const siteId = siteIdentifier(value.siteId);
  const operatorUserId = identifier(value.operatorUserId);
  if (value.environment !== "sandbox" && value.environment !== "live")
    return unavailable();
  return `nr1_${createHash("sha256")
    .update(
      JSON.stringify([
        "receiving.self-nomination.request.v1",
        siteId,
        operatorUserId,
        "ASAAS",
        value.environment,
      ]),
      "utf8",
    )
    .digest("base64url")}`;
}
export function readReceivingNominationConfiguration(
  value: unknown,
): Readonly<ReceivingNominationConfiguration> {
  const config = exactRecord(value, [
    "mode",
    "applicationEnvironment",
    "policyVersion",
    "requestIdentityVersion",
  ]);
  if (
    (config.mode !== "sandbox" && config.mode !== "live") ||
    !["test", "development", "production"].includes(
      config.applicationEnvironment as string,
    ) ||
    (config.mode === "live" &&
      config.applicationEnvironment !== "production") ||
    config.requestIdentityVersion !== "nr1"
  )
    return unavailable();
  return Object.freeze({
    mode: config.mode,
    applicationEnvironment:
      config.applicationEnvironment as ReceivingNominationConfiguration["applicationEnvironment"],
    policyVersion: identifier(config.policyVersion),
    requestIdentityVersion: "nr1",
  });
}

export type ReceivingAuthenticationEvidence = Omit<
  RecentFinancialAuthenticationEvidence,
  "proofKind"
> & {
  proofKind:
    | RecentFinancialAuthenticationEvidence["proofKind"]
    | "SESSION_AUTHENTICATION";
};

export interface ReceivingNominationAuthenticationAudit {
  readonly userId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly proofKind: ReceivingAuthenticationEvidence["proofKind"];
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

// Internal intent only: accountId is a local candidate, never a remote account.
export interface ReceivingNominationSnapshot {
  readonly state: "AWAITING_PROVIDER_VERIFICATION";
  readonly siteId: string;
  readonly requestId: string;
  readonly operatorUserId: string;
  readonly environment: "sandbox" | "live";
  readonly policyVersion: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly requestHash: string;
  readonly authentication: ReceivingNominationAuthenticationAudit;
}

export interface ReceivingProvisioningResult {
  readonly accountReference: string;
  readonly recipientReference: string;
  readonly credential: ProviderCredentialEnvelope;
}
export interface ReceivingProvisioningContext extends ReceivingNominationScope {
  readonly provider: "ASAAS";
  readonly accountId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly policyVersion: string;
  readonly parentAccountReference: string;
  readonly fingerprintVersion: "hkdf-hmac-sha256-v1";
  readonly fingerprintKeyId: string;
  readonly inputFingerprint: string;
  readonly dispatch: {
    readonly leaseOwner: string;
    readonly leaseToken: string;
    readonly leaseExpiresAtMicroseconds: string;
    readonly possibleDispatch: boolean;
  };
}
export interface ReceivingProvisioningRecord {
  readonly version: "receiving.account-provisioning.v1";
  readonly nomination: ReceivingNominationSnapshot;
  readonly provision: ReceivingProvisioningContext;
  readonly sealedResult: ReceivingProvisioningResult | null;
}

export interface ReceivingNominationLockedState {
  access: unknown;
  // The repository must load an actual active stored session/user, or null.
  currentSession: FinancialActor | null;
  designatedOperatorUserId: string | null;
  hasProviderBinding: boolean;
}

export interface ReceivingNominationCurrentAuthorization {
  readonly actor: FinancialActor;
  readonly recentAuth: ReceivingAuthenticationEvidence;
}

// Transient admission evidence deliberately stays outside the persisted v1 intent.
export interface ReceivingNominationAdmissionContext {
  readonly draft: ReceivingNominationSnapshot;
  readonly input: Readonly<ReceivingNominationInput>;
  readonly actor: FinancialActor;
  readonly applicationEnvironment: ReceivingNominationConfiguration["applicationEnvironment"];
}
export interface ReceivingNominationAdmissionPolicy {
  readonly issuerId: string;
  readonly issuerVersion: string;
  readonly disclosureId: string;
  readonly disclosureVersion: string;
}
export interface ReceivingNominationAdmissionAuthority
  extends ReceivingNominationAdmissionPolicy {
  readonly version: "receiving.new-admission.v1";
  readonly context: ReceivingNominationAdmissionContext;
  readonly holderUserId: string;
  readonly authorityId: string;
  readonly authorityVersion: string;
  readonly consentId: string;
  readonly consentVersion: string;
  readonly custodyId: string;
  readonly custodyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface ReceivingNominationAdmissionFrame {
  readonly context: ReceivingNominationAdmissionContext;
  readonly authority: ReceivingNominationAdmissionAuthority;
}
export interface ReceivingNominationAdmissionReader
  extends ReceivingNominationAdmissionPolicy {
  readAuthority(context: ReceivingNominationAdmissionContext): Promise<unknown>;
}

export function captureReceivingNominationAdmissionPolicy(
  value: unknown,
): ReceivingNominationAdmissionPolicy {
  const raw = captureDataProperties(value, [
    "issuerId",
    "issuerVersion",
    "disclosureId",
    "disclosureVersion",
  ]);
  return Object.freeze({
    issuerId: identifier(raw.issuerId),
    issuerVersion: identifier(raw.issuerVersion),
    disclosureId: identifier(raw.disclosureId),
    disclosureVersion: identifier(raw.disclosureVersion),
  });
}
export function captureReceivingNominationAdmissionContext(
  value: unknown,
): ReceivingNominationAdmissionContext {
  try {
    const raw = exactRecord(value, [
      "draft",
      "input",
      "actor",
      "applicationEnvironment",
    ]);
    const draft = readReceivingNominationSnapshot(raw.draft);
    const actor = readActor(raw.actor);
    const input = readInput(raw.input, draft.policyVersion);
    if (
      actor.siteId !== draft.siteId ||
      actor.userId !== draft.operatorUserId ||
      input.requestId !== draft.requestId ||
      !["test", "development", "production"].includes(
        raw.applicationEnvironment as string,
      ) ||
      (draft.environment === "live" &&
        raw.applicationEnvironment !== "production")
    )
      return unavailable();
    return Object.freeze({
      draft,
      input,
      actor,
      applicationEnvironment:
        raw.applicationEnvironment as ReceivingNominationConfiguration["applicationEnvironment"],
    });
  } catch {
    return unavailable();
  }
}

export function captureReceivingNominationAdmissionAuthority(
  value: unknown,
  context: ReceivingNominationAdmissionContext,
  policy: ReceivingNominationAdmissionPolicy,
): ReceivingNominationAdmissionAuthority {
  const raw = exactRecord(value, [
    "version",
    "context",
    "holderUserId",
    "authorityId",
    "authorityVersion",
    "consentId",
    "consentVersion",
    "custodyId",
    "custodyVersion",
    "issuerId",
    "issuerVersion",
    "disclosureId",
    "disclosureVersion",
    "issuedAt",
    "expiresAt",
  ]);
  const capturedContext = captureReceivingNominationAdmissionContext(
    raw.context,
  );
  const capturedPolicy = captureReceivingNominationAdmissionPolicy(raw);
  if (
    raw.version !== "receiving.new-admission.v1" ||
    raw.holderUserId !== context.actor.userId ||
    !isDeepStrictEqual(capturedContext, context) ||
    !isDeepStrictEqual(capturedPolicy, policy)
  )
    return unavailable();
  return Object.freeze({
    version: "receiving.new-admission.v1",
    context: capturedContext,
    holderUserId: identifier(raw.holderUserId),
    authorityId: identifier(raw.authorityId),
    authorityVersion: identifier(raw.authorityVersion),
    consentId: identifier(raw.consentId),
    consentVersion: identifier(raw.consentVersion),
    custodyId: identifier(raw.custodyId),
    custodyVersion: identifier(raw.custodyVersion),
    ...capturedPolicy,
    issuedAt: instant(raw.issuedAt),
    expiresAt: instant(raw.expiresAt),
  });
}
export function requireReceivingNominationAdmissionTime(
  authority: ReceivingNominationAdmissionAuthority,
  clock: number,
  maxAgeMs: number,
): void {
  const issued = Date.parse(authority.issuedAt),
    expires = Date.parse(authority.expiresAt);
  if (
    issued > clock ||
    clock - issued > maxAgeMs ||
    expires <= clock ||
    expires <= issued ||
    expires - issued > maxAgeMs
  )
    unavailable();
}

export interface ReceivingNominationRepository {
  // Null means a verified empty site/environment scope, never filtered history.
  readNominationScope(
    scope: ReceivingNominationScope,
  ): Promise<ReceivingNominationSnapshot | null>;
  findByRequest(
    siteId: string,
    requestId: string,
  ): Promise<ReceivingNominationSnapshot | null>;
  // Run and await authorization inside the transaction, including exact replay.
  // Return only after commit; preserve original identity and audit on replay.
  reserveNomination(
    snapshot: ReceivingNominationSnapshot,
    authorizeLockedCurrentState: (
      state: ReceivingNominationLockedState,
    ) => Promise<void>,
    currentAuthorization: ReceivingNominationCurrentAuthorization,
    admission?: ReceivingNominationAdmissionFrame,
  ): Promise<ReceivingNominationSnapshot>;
}

export interface ReceivingNominationOptions {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  // This is a server-selected intent version, not provider or legal consent.
  policyVersion: string;
  maxAuthAgeMs: number;
  now(): Date;
  generateId(kind: "account" | "operation"): string;
  loadSite(siteId: string): Promise<{ siteId: string; isDemo: boolean } | null>;
  repository: ReceivingNominationRepository;
  admission?: ReceivingNominationAdmissionReader;
}

export interface ReceivingNominationAttempt {
  actor: FinancialActor | null;
  access: unknown;
  recentAuth: ReceivingAuthenticationEvidence | null;
  input: unknown;
}

export interface ReceivingNominationService {
  readonly configuration: Readonly<ReceivingNominationConfiguration>;
  nominate(
    attempt: ReceivingNominationAttempt,
  ): Promise<ReceivingNominationSnapshot>;
}

export class ReceivingNominationServiceError extends Error {
  readonly title = "Receiving nomination cannot be recorded";
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code:
      | "NOMINATION_INVALID"
      | "MEMBERSHIP_DENIED"
      | "RECENT_AUTH_REQUIRED"
      | "PROVIDER_MODE_UNAVAILABLE"
      | "RECIPIENT_CONFLICT"
      | "RECEIVING_BINDING_EXISTS"
      | "REQUEST_CONFLICT"
      | "RECEIVING_NOMINATION_UNAVAILABLE",
  ) {
    super("Receiving nomination cannot be recorded");
    this.name = "ReceivingNominationServiceError";
  }
}

function unavailable(): never {
  throw new ReceivingNominationServiceError(
    503,
    "RECEIVING_NOMINATION_UNAVAILABLE",
  );
}

export function captureDataProperties(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object") return unavailable();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) return unavailable();
    result[field] = descriptor.value;
  }
  return result;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unavailable();
  return captureDataProperties(value, fields);
}

function identifier(value: unknown): string {
  const parsed = giftQuoteSchema.shape.siteId.safeParse(value);
  if (!parsed.success) return unavailable();
  return parsed.data;
}

function siteIdentifier(value: unknown): string {
  const parsed = siteIdSchema.safeParse(value);
  if (!parsed.success) return unavailable();
  return parsed.data;
}

function instant(value: unknown): string {
  const parsed = giftQuoteSchema.shape.expiresAt.safeParse(value);
  if (!parsed.success || new Date(parsed.data).toISOString() !== parsed.data)
    return unavailable();
  return parsed.data;
}

function intentHash(
  siteId: string,
  requestId: string,
  operatorUserId: string,
  environment: "sandbox" | "live",
  policyVersion: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "receiving.self-nomination.v1",
        siteId,
        requestId,
        operatorUserId,
        environment,
        policyVersion,
        true,
      ]),
      "utf8",
    )
    .digest("hex");
}

// Structural/history validation only. Current actor, membership, proof freshness
// and provider binding still require the repository's locked authorization.
function readLegacyReceivingNominationSnapshot(
  value: unknown,
): ReceivingNominationSnapshot {
  try {
    const raw = exactRecord(value, [
      "state",
      "siteId",
      "requestId",
      "operatorUserId",
      "environment",
      "policyVersion",
      "accountId",
      "operationId",
      "createdAt",
      "requestHash",
      "authentication",
    ]);
    const audit = exactRecord(raw.authentication, [
      "userId",
      "siteId",
      "sessionId",
      "proofKind",
      "authenticatedAt",
      "expiresAt",
    ]);
    const siteId = siteIdentifier(raw.siteId);
    const requestId = identifier(raw.requestId);
    const operatorUserId = identifier(raw.operatorUserId);
    const policyVersion = identifier(raw.policyVersion);
    const accountId = identifier(raw.accountId);
    const operationId = identifier(raw.operationId);
    const createdAt = instant(raw.createdAt);
    const proofKind = audit.proofKind;
    const authenticatedAt =
      proofKind === "SESSION_AUTHENTICATION"
        ? sessionInstant(readDatabaseTimestamp(audit.authenticatedAt))
        : instant(audit.authenticatedAt);
    const expiresAt =
      proofKind === "SESSION_AUTHENTICATION"
        ? sessionInstant(readDatabaseTimestamp(audit.expiresAt))
        : instant(audit.expiresAt);
    if (
      raw.state !== "AWAITING_PROVIDER_VERIFICATION" ||
      (raw.environment !== "sandbox" && raw.environment !== "live") ||
      audit.userId !== operatorUserId ||
      audit.siteId !== siteId ||
      (proofKind !== "PASSWORD_REAUTHENTICATION" &&
        proofKind !== "MFA_REAUTHENTICATION" &&
        proofKind !== "SESSION_AUTHENTICATION") ||
      Date.parse(authenticatedAt) < 0 ||
      Date.parse(authenticatedAt) > Date.parse(createdAt) ||
      Date.parse(createdAt) >= Date.parse(expiresAt) ||
      (proofKind !== "SESSION_AUTHENTICATION" &&
        Date.parse(expiresAt) - Date.parse(authenticatedAt) > 300_000) ||
      raw.requestHash !==
        intentHash(
          siteId,
          requestId,
          operatorUserId,
          raw.environment,
          policyVersion,
        )
    )
      return unavailable();
    return Object.freeze({
      state: "AWAITING_PROVIDER_VERIFICATION",
      siteId,
      requestId,
      operatorUserId,
      environment: raw.environment,
      policyVersion,
      accountId,
      operationId,
      createdAt,
      requestHash: raw.requestHash,
      authentication: Object.freeze({
        userId: operatorUserId,
        siteId,
        sessionId: identifier(audit.sessionId),
        proofKind,
        authenticatedAt,
        expiresAt,
      }),
    });
  } catch {
    return unavailable();
  }
}

function privateIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
function encoded(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return unavailable();
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minimum ||
    decoded.length > maximum ||
    decoded.toString("base64url") !== value
  )
    return unavailable();
  return value;
}
export function readReceivingProvisioningResult(
  value: unknown,
): ReceivingProvisioningResult {
  try {
    const raw = exactRecord(value, [
      "accountReference",
      "recipientReference",
      "credential",
    ]);
    const credential = exactRecord(raw.credential, [
      "version",
      "keyId",
      "nonce",
      "ciphertext",
      "tag",
    ]);
    if (credential.version !== 1) return unavailable();
    return Object.freeze({
      accountReference: privateIdentifier(raw.accountReference),
      recipientReference: privateIdentifier(raw.recipientReference),
      credential: Object.freeze({
        version: 1,
        keyId: privateIdentifier(credential.keyId),
        nonce: encoded(credential.nonce, 12, 12),
        ciphertext: encoded(credential.ciphertext, 1, 8192),
        tag: encoded(credential.tag, 16, 16),
      }),
    });
  } catch {
    return unavailable();
  }
}
export function readReceivingProvisioningRecord(
  value: unknown,
): ReceivingProvisioningRecord {
  try {
    const raw = exactRecord(value, [
      "version",
      "nomination",
      "provision",
      "sealedResult",
    ]);
    if (raw.version !== "receiving.account-provisioning.v1")
      return unavailable();
    const nomination = readLegacyReceivingNominationSnapshot(raw.nomination);
    const provision = exactRecord(raw.provision, [
      "provider",
      "siteId",
      "accountId",
      "operationId",
      "requestId",
      "operatorUserId",
      "environment",
      "policyVersion",
      "parentAccountReference",
      "fingerprintVersion",
      "fingerprintKeyId",
      "inputFingerprint",
      "dispatch",
    ]);
    for (const field of [
      "siteId",
      "accountId",
      "operationId",
      "requestId",
      "operatorUserId",
      "environment",
      "policyVersion",
    ] as const)
      if (provision[field] !== nomination[field]) return unavailable();
    if (
      provision.provider !== "ASAAS" ||
      provision.fingerprintVersion !== "hkdf-hmac-sha256-v1" ||
      typeof provision.inputFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(provision.inputFingerprint)
    )
      return unavailable();
    const dispatch = exactRecord(provision.dispatch, [
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAtMicroseconds",
      "possibleDispatch",
    ]);
    if (
      typeof dispatch.possibleDispatch !== "boolean" ||
      typeof dispatch.leaseExpiresAtMicroseconds !== "string" ||
      !/^[1-9]\d{0,18}$/.test(dispatch.leaseExpiresAtMicroseconds) ||
      BigInt(dispatch.leaseExpiresAtMicroseconds) > 8640000000000000000n ||
      BigInt(dispatch.leaseExpiresAtMicroseconds) <=
        BigInt(Date.parse(nomination.createdAt)) * 1000n ||
      (raw.sealedResult !== null && !dispatch.possibleDispatch)
    )
      return unavailable();
    return Object.freeze({
      version: "receiving.account-provisioning.v1",
      nomination,
      provision: Object.freeze({
        provider: "ASAAS",
        siteId: nomination.siteId,
        accountId: nomination.accountId,
        operationId: nomination.operationId,
        requestId: nomination.requestId,
        operatorUserId: nomination.operatorUserId,
        environment: nomination.environment,
        policyVersion: nomination.policyVersion,
        parentAccountReference: privateIdentifier(
          provision.parentAccountReference,
        ),
        fingerprintVersion: "hkdf-hmac-sha256-v1",
        fingerprintKeyId: privateIdentifier(provision.fingerprintKeyId),
        inputFingerprint: provision.inputFingerprint,
        dispatch: Object.freeze({
          leaseOwner: privateIdentifier(dispatch.leaseOwner),
          leaseToken: privateIdentifier(dispatch.leaseToken),
          leaseExpiresAtMicroseconds: dispatch.leaseExpiresAtMicroseconds,
          possibleDispatch: dispatch.possibleDispatch,
        }),
      }),
      sealedResult:
        raw.sealedResult === null
          ? null
          : readReceivingProvisioningResult(raw.sealedResult),
    });
  } catch {
    return unavailable();
  }
}
// Private lifecycle fields never widen the public nomination projection.
export function readReceivingNominationSnapshot(
  value: unknown,
): ReceivingNominationSnapshot {
  if (value && typeof value === "object" && Object.hasOwn(value, "version"))
    return readReceivingProvisioningRecord(value).nomination;
  return readLegacyReceivingNominationSnapshot(value);
}

function eligible(access: unknown, actor: FinancialActor | null): void {
  const parsed = siteAccessSchema.safeParse(access);
  if (
    !actor ||
    !parsed.success ||
    parsed.data.siteId !== actor.siteId ||
    parsed.data.userId !== actor.userId ||
    parsed.data.membershipRole !== "SITE_ADMIN" ||
    parsed.data.membershipId === null ||
    !parsed.data.capabilities.configureReceiving
  )
    throw new ReceivingNominationServiceError(403, "MEMBERSHIP_DENIED");
}

function readActor(value: unknown): FinancialActor {
  try {
    const raw = exactRecord(value, ["userId", "siteId", "sessionId"]);
    return Object.freeze({
      userId: identifier(raw.userId),
      siteId: siteIdentifier(raw.siteId),
      sessionId: identifier(raw.sessionId),
    });
  } catch {
    throw new ReceivingNominationServiceError(403, "MEMBERSHIP_DENIED");
  }
}

function readInput(
  value: unknown,
  policyVersion: string,
): ReceivingNominationInput {
  try {
    const raw = exactRecord(value, [
      "requestId",
      "confirmSelfAsRecipient",
      "policyVersion",
    ]);
    if (
      raw.confirmSelfAsRecipient !== true ||
      raw.policyVersion !== policyVersion
    )
      throw new Error();
    return Object.freeze({
      requestId: identifier(raw.requestId),
      confirmSelfAsRecipient: true,
      policyVersion,
    });
  } catch {
    throw new ReceivingNominationServiceError(400, "NOMINATION_INVALID");
  }
}

const nativeDateTime = Date.prototype.getTime;
function dateTime(value: unknown): number {
  if (!(value instanceof Date)) return unavailable();
  const time = nativeDateTime.call(value);
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    !giftQuoteSchema.shape.expiresAt.safeParse(new Date(time).toISOString())
      .success
  )
    return unavailable();
  return time;
}

function sessionInstant(value: unknown): string {
  const milliseconds = dateTime(value);
  const microseconds = databaseTimestampEpochMicroseconds(value);
  const iso = new Date(milliseconds).toISOString();
  return microseconds % 1000n === 0n
    ? iso
    : `${iso.slice(0, 19)}.${(microseconds % 1000000n).toString().padStart(6, "0")}Z`;
}

function freshProof(
  audit: ReceivingNominationAuthenticationAudit,
  now: number,
  maxAuthAgeMs: number,
): void {
  const maximumAge =
    audit.proofKind === "SESSION_AUTHENTICATION"
      ? ADMIN_ABSOLUTE_TIMEOUT_MS
      : maxAuthAgeMs;
  const authenticated = Date.parse(audit.authenticatedAt);
  const expiry = Date.parse(audit.expiresAt);
  if (
    authenticated > now ||
    now - authenticated > maximumAge ||
    expiry <= now ||
    (audit.proofKind !== "SESSION_AUTHENTICATION" &&
      expiry - authenticated > maximumAge)
  )
    throw new ReceivingNominationServiceError(403, "RECENT_AUTH_REQUIRED");
}

function captureProof(
  value: unknown,
  actor: FinancialActor,
  now: () => number,
  maxAuthAgeMs: number,
): ReceivingNominationAuthenticationAudit {
  try {
    const raw = exactRecord(value, [
      "userId",
      "siteId",
      "sessionId",
      "proofKind",
      "verification",
      "provenance",
      "authenticatedAt",
      "expiresAt",
    ]);
    const proofKind = raw.proofKind;
    if (
      raw.userId !== actor.userId ||
      raw.siteId !== actor.siteId ||
      raw.sessionId !== actor.sessionId ||
      raw.verification !== "verified" ||
      raw.provenance !== "backend" ||
      (proofKind !== "PASSWORD_REAUTHENTICATION" &&
        proofKind !== "MFA_REAUTHENTICATION" &&
        proofKind !== "SESSION_AUTHENTICATION")
    )
      throw new Error();
    const audit = Object.freeze({
      ...actor,
      proofKind,
      authenticatedAt:
        proofKind === "SESSION_AUTHENTICATION"
          ? sessionInstant(raw.authenticatedAt)
          : new Date(dateTime(raw.authenticatedAt)).toISOString(),
      expiresAt:
        proofKind === "SESSION_AUTHENTICATION"
          ? sessionInstant(raw.expiresAt)
          : new Date(dateTime(raw.expiresAt)).toISOString(),
    });
    freshProof(audit, now(), maxAuthAgeMs);
    return audit;
  } catch {
    throw new ReceivingNominationServiceError(403, "RECENT_AUTH_REQUIRED");
  }
}

function currentAuthorization(
  actor: FinancialActor,
  audit: ReceivingNominationAuthenticationAudit,
): ReceivingNominationCurrentAuthorization {
  return Object.freeze({
    actor: Object.freeze({ ...actor }),
    recentAuth: Object.freeze({
      ...actor,
      proofKind: audit.proofKind,
      verification: "verified",
      provenance: "backend",
      authenticatedAt: readDatabaseTimestamp(audit.authenticatedAt),
      expiresAt: readDatabaseTimestamp(audit.expiresAt),
    }),
  });
}

export function createReceivingNominationService(
  options: ReceivingNominationOptions,
): ReceivingNominationService {
  try {
    const raw = captureDataProperties(options, [
      "mode",
      "applicationEnvironment",
      "policyVersion",
      "maxAuthAgeMs",
      "now",
      "generateId",
      "loadSite",
      "repository",
    ]);
    const maxAuthAgeMs = raw.maxAuthAgeMs as number;
    const mode = raw.mode as ReceivingNominationOptions["mode"];
    const applicationEnvironment =
      raw.applicationEnvironment as ReceivingNominationOptions["applicationEnvironment"];
    const ports = captureDataProperties(raw.repository, [
      "readNominationScope",
      "findByRequest",
      "reserveNomination",
    ]);
    let admissionPolicy: ReceivingNominationAdmissionPolicy | null = null;
    let admissionRead:
      | ReceivingNominationAdmissionReader["readAuthority"]
      | null = null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(options, "admission");
      if (
        descriptor &&
        "value" in descriptor &&
        descriptor.value !== undefined
      ) {
        const policy = captureReceivingNominationAdmissionPolicy(
          descriptor.value,
        );
        const read = captureDataProperties(descriptor.value, [
          "readAuthority",
        ]).readAuthority;
        if (typeof read !== "function") unavailable();
        admissionPolicy = policy;
        admissionRead =
          read as ReceivingNominationAdmissionReader["readAuthority"];
      }
    } catch {
      // Missing private NEW authority must not reinterpret known replay.
    }
    if (
      (mode !== "sandbox" && mode !== "live") ||
      (mode === "live" && applicationEnvironment !== "production")
    )
      throw new ReceivingNominationServiceError(
        409,
        "PROVIDER_MODE_UNAVAILABLE",
      );
    if (
      !["test", "development", "production"].includes(applicationEnvironment) ||
      !Number.isSafeInteger(maxAuthAgeMs) ||
      maxAuthAgeMs < 1 ||
      maxAuthAgeMs > 300_000 ||
      typeof raw.now !== "function" ||
      typeof raw.generateId !== "function" ||
      typeof raw.loadSite !== "function" ||
      typeof ports.readNominationScope !== "function" ||
      typeof ports.findByRequest !== "function" ||
      typeof ports.reserveNomination !== "function"
    )
      return unavailable();
    const policyVersion = identifier(raw.policyVersion);
    const now = Function.prototype.bind.call(
      raw.now,
      options,
    ) as ReceivingNominationOptions["now"];
    const generateId = Function.prototype.bind.call(
      raw.generateId,
      options,
    ) as ReceivingNominationOptions["generateId"];
    const loadSite = Function.prototype.bind.call(
      raw.loadSite,
      options,
    ) as ReceivingNominationOptions["loadSite"];
    const findByRequest = Function.prototype.bind.call(
      ports.findByRequest,
      raw.repository,
    ) as ReceivingNominationRepository["findByRequest"];
    const reserveNomination = Function.prototype.bind.call(
      ports.reserveNomination,
      raw.repository,
    ) as ReceivingNominationRepository["reserveNomination"];
    const readScope = Function.prototype.bind.call(
      ports.readNominationScope,
      raw.repository,
    ) as ReceivingNominationRepository["readNominationScope"];
    return {
      configuration: readReceivingNominationConfiguration({
        mode,
        applicationEnvironment,
        policyVersion,
        requestIdentityVersion: "nr1",
      }),
      async nominate(attempt) {
        try {
          const originalAttempt = captureDataProperties(attempt, [
            "actor",
            "access",
            "recentAuth",
            "input",
          ]);
          const actor = readActor(originalAttempt.actor);
          eligible(originalAttempt.access, actor);
          const input = readInput(originalAttempt.input, policyVersion);
          let lastClock: number | null = null;
          const clock = () => {
            const current = dateTime(now());
            if (lastClock !== null && current < lastClock) return unavailable();
            lastClock = current;
            return current;
          };
          const audit = captureProof(
            originalAttempt.recentAuth,
            actor,
            clock,
            maxAuthAgeMs,
          );
          const site = exactRecord(
            (await observeNominationSettlement(loadSite(actor.siteId))).value,
            ["siteId", "isDemo"],
          );
          freshProof(audit, clock(), maxAuthAgeMs);
          if (site.siteId !== actor.siteId || typeof site.isDemo !== "boolean")
            return unavailable();
          if (mode === "live" && site.isDemo)
            throw new ReceivingNominationServiceError(
              409,
              "PROVIDER_MODE_UNAVAILABLE",
            );
          let previousValue = (
            await observeNominationSettlement(
              findByRequest(actor.siteId, input.requestId),
            )
          ).value;
          if (previousValue === null) {
            const scope = Object.freeze({
              siteId: actor.siteId,
              operatorUserId: actor.userId,
              environment: mode,
            });
            previousValue = (
              await observeNominationSettlement(readScope(scope))
            ).value;
            if (
              previousValue === null &&
              input.requestId !== deriveReceivingNominationRequestId(scope)
            )
              throw new ReceivingNominationServiceError(
                409,
                "REQUEST_CONFLICT",
              );
            if (
              previousValue !== null &&
              previousValue.requestId !== input.requestId
            )
              throw new ReceivingNominationServiceError(
                409,
                "REQUEST_CONFLICT",
              );
          }
          const lookedAt = clock();
          freshProof(audit, lookedAt, maxAuthAgeMs);
          const previous =
            previousValue === null
              ? null
              : readReceivingNominationSnapshot(previousValue);
          const requestHash = intentHash(
            actor.siteId,
            input.requestId,
            actor.userId,
            mode,
            policyVersion,
          );
          if (previous) {
            if (
              previous.siteId !== actor.siteId ||
              previous.requestId !== input.requestId ||
              Date.parse(previous.createdAt) > lookedAt
            )
              return unavailable();
            if (previous.requestHash !== requestHash)
              throw new ReceivingNominationServiceError(
                409,
                "REQUEST_CONFLICT",
              );
          }
          let snapshot = previous;
          if (snapshot === null) {
            const accountId = identifier(generateId("account"));
            const operationId = identifier(generateId("operation"));
            const created = clock();
            freshProof(audit, created, maxAuthAgeMs);
            snapshot = readReceivingNominationSnapshot({
              state: "AWAITING_PROVIDER_VERIFICATION",
              siteId: actor.siteId,
              requestId: input.requestId,
              operatorUserId: actor.userId,
              environment: mode,
              policyVersion,
              accountId,
              operationId,
              createdAt: new Date(created).toISOString(),
              requestHash,
              authentication: audit,
            });
          }
          const authorization = currentAuthorization(actor, audit);
          let admissionFrame: ReceivingNominationAdmissionFrame | undefined;
          if (
            previous === null &&
            admissionPolicy &&
            typeof admissionRead === "function"
          ) {
            const context = captureReceivingNominationAdmissionContext({
              draft: snapshot,
              input,
              actor,
              applicationEnvironment,
            });
            const authority = captureReceivingNominationAdmissionAuthority(
              (await observeNominationSettlement(admissionRead(context))).value,
              context,
              admissionPolicy,
            );
            const capturedAt = clock();
            freshProof(audit, capturedAt, maxAuthAgeMs);
            requireReceivingNominationAdmissionTime(
              authority,
              capturedAt,
              maxAuthAgeMs,
            );
            admissionFrame = Object.freeze({ context, authority });
          }
          let authorized = false;
          const { value: committed } = await observeNominationSettlement(
            reserveNomination(
              snapshot,
              async (state) => {
                authorized = false;
                const locked = exactRecord(state, [
                  "access",
                  "currentSession",
                  "designatedOperatorUserId",
                  "hasProviderBinding",
                ]);
                const currentSession = readActor(locked.currentSession);
                if (!isDeepStrictEqual(currentSession, actor))
                  throw new ReceivingNominationServiceError(
                    403,
                    "MEMBERSHIP_DENIED",
                  );
                eligible(locked.access, actor);
                freshProof(audit, clock(), maxAuthAgeMs);
                if (
                  typeof locked.hasProviderBinding !== "boolean" ||
                  (locked.designatedOperatorUserId !== null &&
                    typeof locked.designatedOperatorUserId !== "string")
                )
                  return unavailable();
                if (locked.designatedOperatorUserId !== null)
                  identifier(locked.designatedOperatorUserId);
                if (locked.hasProviderBinding)
                  throw new ReceivingNominationServiceError(
                    409,
                    "RECEIVING_BINDING_EXISTS",
                  );
                if (
                  locked.designatedOperatorUserId !== null &&
                  (locked.designatedOperatorUserId !== actor.userId ||
                    previous === null)
                )
                  throw new ReceivingNominationServiceError(
                    409,
                    "RECIPIENT_CONFLICT",
                  );
                authorized = true;
              },
              authorization,
              admissionFrame,
            ),
          );
          const acknowledgedAt = clock();
          freshProof(audit, acknowledgedAt, maxAuthAgeMs);
          if (admissionFrame)
            requireReceivingNominationAdmissionTime(
              admissionFrame.authority,
              acknowledgedAt,
              maxAuthAgeMs,
            );
          if (!authorized) return unavailable();
          const result = readReceivingNominationSnapshot(committed);
          if (!isDeepStrictEqual(result, snapshot)) return unavailable();
          return result;
        } catch (error) {
          if (error instanceof ReceivingNominationServiceError) throw error;
          return unavailable();
        }
      },
    };
  } catch (error) {
    if (error instanceof ReceivingNominationServiceError) throw error;
    return unavailable();
  }
}
