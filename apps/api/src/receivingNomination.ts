import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  giftQuoteSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import type { ProviderCredentialEnvelope } from "./providerCredentials";

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

export interface ReceivingNominationAuthenticationAudit {
  readonly userId: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly proofKind: "PASSWORD_REAUTHENTICATION" | "MFA_REAUTHENTICATION";
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
  readonly recentAuth: RecentFinancialAuthenticationEvidence;
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
}

export interface ReceivingNominationAttempt {
  actor: FinancialActor | null;
  access: unknown;
  recentAuth: RecentFinancialAuthenticationEvidence | null;
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
  return value as Record<string, unknown>;
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
    const authenticatedAt = instant(audit.authenticatedAt);
    const expiresAt = instant(audit.expiresAt);
    const proofKind = audit.proofKind;
    if (
      raw.state !== "AWAITING_PROVIDER_VERIFICATION" ||
      (raw.environment !== "sandbox" && raw.environment !== "live") ||
      audit.userId !== operatorUserId ||
      audit.siteId !== siteId ||
      (proofKind !== "PASSWORD_REAUTHENTICATION" &&
        proofKind !== "MFA_REAUTHENTICATION") ||
      Date.parse(authenticatedAt) < 0 ||
      Date.parse(authenticatedAt) > Date.parse(createdAt) ||
      Date.parse(createdAt) >= Date.parse(expiresAt) ||
      Date.parse(expiresAt) - Date.parse(authenticatedAt) > 300_000 ||
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

function dateTime(value: unknown): number {
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    value.getTime() < 0 ||
    !giftQuoteSchema.shape.expiresAt.safeParse(value.toISOString()).success
  )
    return unavailable();
  return value.getTime();
}

function freshProof(
  audit: ReceivingNominationAuthenticationAudit,
  now: number,
  maxAuthAgeMs: number,
): void {
  const authenticated = Date.parse(audit.authenticatedAt);
  const expiry = Date.parse(audit.expiresAt);
  if (
    authenticated > now ||
    now - authenticated > maxAuthAgeMs ||
    expiry <= now ||
    expiry - authenticated > maxAuthAgeMs
  )
    throw new ReceivingNominationServiceError(403, "RECENT_AUTH_REQUIRED");
}

function captureProof(
  value: unknown,
  actor: FinancialActor,
  now: number,
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
        proofKind !== "MFA_REAUTHENTICATION")
    )
      throw new Error();
    const audit = Object.freeze({
      ...actor,
      proofKind,
      authenticatedAt: new Date(dateTime(raw.authenticatedAt)).toISOString(),
      expiresAt: new Date(dateTime(raw.expiresAt)).toISOString(),
    });
    freshProof(audit, now, maxAuthAgeMs);
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
      authenticatedAt: new Date(audit.authenticatedAt),
      expiresAt: new Date(audit.expiresAt),
    }),
  });
}

export function createReceivingNominationService(
  options: ReceivingNominationOptions,
): ReceivingNominationService {
  try {
    const mode = options.mode;
    const applicationEnvironment = options.applicationEnvironment;
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
      !Number.isSafeInteger(options.maxAuthAgeMs) ||
      options.maxAuthAgeMs < 1 ||
      options.maxAuthAgeMs > 300_000 ||
      typeof options.now !== "function" ||
      typeof options.generateId !== "function" ||
      typeof options.loadSite !== "function" ||
      typeof options.repository?.readNominationScope !== "function" ||
      typeof options.repository?.findByRequest !== "function" ||
      typeof options.repository?.reserveNomination !== "function"
    )
      return unavailable();
    const policyVersion = identifier(options.policyVersion);
    const maxAuthAgeMs = options.maxAuthAgeMs;
    const now = options.now.bind(options);
    const generateId = options.generateId.bind(options);
    const loadSite = options.loadSite.bind(options);
    const findByRequest = options.repository.findByRequest.bind(
      options.repository,
    );
    const reserveNomination = options.repository.reserveNomination.bind(
      options.repository,
    );
    const readScope = options.repository.readNominationScope.bind(
      options.repository,
    );
    return {
      configuration: readReceivingNominationConfiguration({
        mode,
        applicationEnvironment,
        policyVersion,
        requestIdentityVersion: "nr1",
      }),
      async nominate(attempt) {
        try {
          const actor = readActor(attempt.actor);
          eligible(attempt.access, actor);
          const input = readInput(attempt.input, policyVersion);
          let lastClock: number | null = null;
          const clock = () => {
            const current = dateTime(now());
            if (lastClock !== null && current < lastClock) return unavailable();
            lastClock = current;
            return current;
          };
          const audit = captureProof(
            attempt.recentAuth,
            actor,
            clock(),
            maxAuthAgeMs,
          );
          const site = exactRecord(await loadSite(actor.siteId), [
            "siteId",
            "isDemo",
          ]);
          freshProof(audit, clock(), maxAuthAgeMs);
          if (site.siteId !== actor.siteId || typeof site.isDemo !== "boolean")
            return unavailable();
          if (mode === "live" && site.isDemo)
            throw new ReceivingNominationServiceError(
              409,
              "PROVIDER_MODE_UNAVAILABLE",
            );
          let previousValue = await findByRequest(
            actor.siteId,
            input.requestId,
          );
          if (previousValue === null) {
            const scope = Object.freeze({
              siteId: actor.siteId,
              operatorUserId: actor.userId,
              environment: mode,
            });
            previousValue = await readScope(scope);
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
          let authorized = false;
          const committed = await reserveNomination(
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
            currentAuthorization(actor, audit),
          );
          freshProof(audit, clock(), maxAuthAgeMs);
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
