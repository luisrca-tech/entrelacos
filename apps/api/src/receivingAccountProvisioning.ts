import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ReceivingSetupReconcileReason,
  receivingSetupAccountSchema,
} from "@entrelacos/contracts";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import {
  logObservabilityEvent,
  PROVIDER_FIELD_LIMIT,
  PROVIDER_MESSAGE_LIMIT,
} from "./observability";
import { PagarmeRejectedError } from "./pagarmeHttpClient";
import type {
  PagarmeRecipientClient,
  PagarmeRecipientInput,
} from "./pagarmeRecipientClient";
import {
  RECEIVING_ABSENCE_GRACE_MICROSECONDS,
  type ReceivingDispatchReleaseCode,
  type ReceivingNominationCurrentAuthorization,
  type ReceivingNominationSnapshot,
  type ReceivingProvisioningContext,
  type ReceivingProvisioningRecord,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
  readReceivingProvisioningResult,
} from "./receivingNomination";

export type ReceivingFingerprintKeyring = ReadonlyMap<string, Uint8Array>;
export const RECEIVING_FINGERPRINT_KEY_ID = "receiving-fingerprint-v1";
/** Keys only the input fingerprint; it never encrypts or authenticates a provider. */
export function deriveReceivingFingerprintKey(secret: string): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      "entrelacos-receiving-fingerprint-v1",
      "input-fingerprint",
      32,
    ),
  );
}
export function readReceivingRecipientInput(
  value: unknown,
): Readonly<PagarmeRecipientInput> {
  const parsed = receivingSetupAccountSchema.safeParse(value);
  if (!parsed.success) return unavailable();
  return Object.freeze(parsed.data);
}

export class ReceivingAccountProvisioningError extends Error {
  readonly status = 503;
  readonly code = "RECEIVING_PROVISIONING_UNAVAILABLE";
  constructor() {
    super("Account provisioning unavailable");
  }
}
function unavailable(): never {
  throw new ReceivingAccountProvisioningError();
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
export type ProvisioningIdentity = Omit<
  ReceivingProvisioningContext,
  "dispatch"
>;
export interface ReceivingProvisioningClaimInput {
  readonly nomination: ReceivingNominationSnapshot;
  readonly provision: ProvisioningIdentity;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}
export interface ReceivingProvisioningObservation {
  readonly record: ReceivingProvisioningRecord;
  readonly state: "CLAIMED" | "UNKNOWN" | "SUCCEEDED";
  readonly result: ReceivingProvisioningResult | null;
}
export interface ReceivingAccountProvisioningRepository {
  claimOriginal(
    input: ReceivingProvisioningClaimInput,
    authorization: ReceivingNominationCurrentAuthorization,
  ): Promise<ReceivingProvisioningRecord>;
  armOriginal(
    claim: ReceivingProvisioningRecord,
    authorization: ReceivingNominationCurrentAuthorization,
  ): Promise<void>;
  confirmOriginalArmForDispatch(
    claim: ReceivingProvisioningRecord,
    authorization: ReceivingNominationCurrentAuthorization,
  ): Promise<void>;
  quarantineOriginal(
    claim: ReceivingProvisioningRecord,
    result: ReceivingProvisioningResult,
  ): Promise<void>;
  attachOriginal(
    claim: ReceivingProvisioningRecord,
    result: ReceivingProvisioningResult,
    authorization: ReceivingNominationCurrentAuthorization,
  ): Promise<void>;
  consultOriginal(
    claim: ReceivingProvisioningRecord,
    expectedResult: ReceivingProvisioningResult | null,
  ): Promise<ReceivingProvisioningObservation | null>;
  /**
   * Returns an armed dispatch without a stored result to REQUESTED, counting
   * it, so the next submit dispatches again. `PROVIDER_ABSENT` is accepted
   * only well after the dispatch lease expired.
   */
  releaseOriginal(
    claim: ReceivingProvisioningRecord,
    reason: ReceivingDispatchReleaseCode,
  ): Promise<void>;
}
export interface ReceivingProvisioningProvider {
  readonly approved: true;
  readonly environment: "sandbox" | "live";
  /** The platform Pagar.me recipient that receives the platform split. */
  readonly parentAccountReference: string;
  readonly policyVersion: string;
  readonly recipients: Pick<
    PagarmeRecipientClient,
    "createRecipient" | "findRecipientByCode"
  >;
}
interface Options {
  repository: ReceivingAccountProvisioningRepository;
  readProvider(
    nomination: ReceivingNominationSnapshot,
  ): Promise<ReceivingProvisioningProvider | null>;
  fingerprintKeys: ReceivingFingerprintKeyring;
  activeFingerprintKeyId: string;
  now(): Date;
  generateId?(kind: "owner" | "token"): string;
  /** Receives PII-free failure events; defaults to the structured log. */
  observe?(event: ReceivingProvisioningFailureEvent): void;
}
export type ReceivingProvisioningStage =
  | "validate"
  | "provider_check"
  | "claim"
  | "arm"
  | "confirm_arm"
  | "create_recipient"
  | "consult_provider"
  | "release"
  | "quarantine"
  | "attach"
  | "consult";
export interface ReceivingProvisioningFailureEvent {
  readonly level: "warn";
  readonly event: "receiving.provisioning.failed";
  /** The stage that failed. */
  readonly operation: ReceivingProvisioningStage;
  /**
   * "recovering" when the owner continues by consulting the stored result;
   * "rejected" when Pagar.me definitively refused the recipient.
   */
  readonly result: "recovering" | "unknown" | "unavailable" | "rejected";
  readonly errorCode: string;
  readonly siteId?: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  /** `field.path: message | message`, without the submitted values. */
  readonly providerFields?: string[];
}
/**
 * A definitive refusal of POST /recipients: nothing was created. 401, 403,
 * 404, 409 and 429 say nothing about the payload, so they stay uncertain.
 */
const DEFINITIVE_REJECTIONS = new Set([400, 412, 422]);
/** The contract bound of one field message shown to the holder. */
const PROVIDER_FIELD_MESSAGE_LIMIT = 240;
/** The provider reason the holder can act on, free of submitted values. */
export interface ReceivingProviderRejection {
  readonly status: number;
  readonly message: string | null;
  readonly fields: readonly {
    readonly field: string;
    readonly messages: readonly string[];
  }[];
}
function inputValues(input: PagarmeRecipientInput): string[] {
  const values = [
    input.name,
    ...input.name.split(/\s+/),
    ...input.bankAccount.holderName.split(/\s+/),
    input.email,
    input.cpf,
    input.mobilePhone,
    input.birthDate,
    input.professionalOccupation,
    ...Object.values(input.address),
    ...Object.values(input.bankAccount),
  ];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.normalize("NFC").trim())
        .filter((value) => value.length >= 3),
    ),
  ].sort((left, right) => right.length - left.length);
}
/** Removes any submitted value the provider echoed, ignoring case. */
function withoutInput(text: string, values: readonly string[]): string {
  let redacted = text.normalize("NFC");
  for (const value of values)
    redacted = redacted.replace(
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"),
      "[valor]",
    );
  return redacted;
}
function describeRejection(
  error: PagarmeRejectedError,
  input: PagarmeRecipientInput | undefined,
): ReceivingProviderRejection {
  const values = input ? inputValues(input) : [];
  const message =
    error.providerMessage === null
      ? null
      : withoutInput(error.providerMessage, values).slice(
          0,
          PROVIDER_MESSAGE_LIMIT,
        );
  return Object.freeze({
    status: error.status,
    message,
    fields: error.providerFields.slice(0, PROVIDER_FIELD_LIMIT).map((field) =>
      Object.freeze({
        field: field.field,
        // Redaction can lengthen a message ("[valor]"), so bound it after.
        messages: field.messages.map((text) =>
          withoutInput(text, values).slice(0, PROVIDER_FIELD_MESSAGE_LIMIT),
        ),
      }),
    ),
  });
}
/**
 * Describes a failure without its message: only the error class and, for a
 * Pagar.me rejection, the HTTP status, provider code, redacted reason and
 * field paths. The observability sanitizer bounds and redacts them again.
 */
function failureDetails(error: unknown, input?: PagarmeRecipientInput) {
  const errorCode =
    error instanceof Error
      ? error.name !== "Error"
        ? error.name
        : error.constructor.name
      : "unknown";
  if (!(error instanceof PagarmeRejectedError)) return { errorCode };
  const rejection = describeRejection(error, input);
  return {
    errorCode,
    status: error.status,
    ...(error.providerCode === null
      ? {}
      : { providerCode: error.providerCode }),
    ...(rejection.message ? { providerMessage: rejection.message } : {}),
    ...(rejection.fields.length
      ? {
          providerFields: rejection.fields.map((field) =>
            field.messages.length
              ? `${field.field}: ${field.messages.join(" | ")}`
              : field.field,
          ),
        }
      : {}),
  };
}
export type ReceivingProvisioningCommand = {
  readonly nomination: ReceivingNominationSnapshot;
  readonly authorization: ReceivingNominationCurrentAuthorization;
  readonly confirmNativeCreation: true;
} & (
  | { readonly action: "CREATE"; readonly input: PagarmeRecipientInput }
  | {
      readonly action: "SETTLE";
      readonly input: PagarmeRecipientInput;
      readonly record: ReceivingProvisioningRecord;
    }
  /**
   * An armed dispatch without a stored result: consult Pagar.me by the
   * account code, attach what it holds, or release and create again once
   * it is proven absent.
   */
  | {
      readonly action: "RECONCILE";
      readonly input: PagarmeRecipientInput;
      readonly record: ReceivingProvisioningRecord;
    }
  /**
   * The RECONCILE consultation alone, without recipient input: attach what
   * Pagar.me holds or release a dispatch proven absent, then stop. It never
   * creates a recipient; the holder submits again after a release.
   */
  | {
      readonly action: "VERIFY";
      readonly record: ReceivingProvisioningRecord;
    }
);
interface Feedback {
  /** RELEASED only answers VERIFY: the dispatch is back to REQUESTED. */
  readonly state:
    | "UNAVAILABLE"
    | "UNKNOWN"
    | "STORED"
    | "REJECTED"
    | "RELEASED";
  readonly siteId?: string;
  readonly requestId?: string;
  readonly accountId?: string;
  readonly operationId?: string;
  /** Only with REJECTED: the dispatch was released for a corrected submit. */
  readonly rejection?: ReceivingProviderRejection;
  /** Only with UNKNOWN after VERIFY: why the dispatch stays uncertain. */
  readonly reason?: ReceivingSetupReconcileReason;
}
export interface ReceivingProvisioningOwner {
  readonly feedback: Promise<Feedback>;
  readonly completion: Promise<void>;
  cancel(): void;
}

export function deriveReceivingProvisioningContext(
  inputNomination: ReceivingNominationSnapshot,
  parentAccountReference: string,
  fingerprintKeyId: string,
  input: PagarmeRecipientInput,
  keyring: ReceivingFingerprintKeyring,
): Readonly<ProvisioningIdentity> {
  let root: Buffer | undefined;
  let derived: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    const nomination = readReceivingNominationSnapshot(inputNomination);
    const parent = identifier(parentAccountReference);
    const id = identifier(fingerprintKeyId);
    const key = keyring.get(id);
    if (!(key instanceof Uint8Array) || key.byteLength !== 32)
      return unavailable();
    const fields = readReceivingRecipientInput(input);
    const address = fields.address;
    const bank = fields.bankAccount;
    root = Buffer.from(key);
    derived = Buffer.from(
      hkdfSync(
        "sha256",
        root,
        Buffer.from("entrelacos.receiving-provisioning.hkdf.v1"),
        Buffer.from("entrelacos.receiving-provisioning.input-fingerprint.v1"),
        32,
      ),
    );
    canonical = Buffer.from(
      JSON.stringify([
        "entrelacos.receiving-provisioning.input.v3",
        "hkdf-hmac-sha256-v1",
        id,
        "PAGARME",
        nomination.siteId,
        nomination.accountId,
        nomination.operationId,
        nomination.requestId,
        nomination.requestHash,
        nomination.operatorUserId,
        nomination.environment,
        nomination.policyVersion,
        parent,
        fields.name,
        fields.email,
        fields.cpf,
        fields.mobilePhone,
        fields.birthDate,
        fields.monthlyIncomeCents,
        fields.professionalOccupation,
        address.street,
        address.streetNumber,
        address.complement ?? null,
        address.neighborhood,
        address.city,
        address.state,
        address.zipCode,
        address.referencePoint ?? null,
        bank.bank,
        bank.branchNumber,
        bank.branchCheckDigit ?? null,
        bank.accountNumber,
        bank.accountCheckDigit,
        bank.holderName,
        bank.type,
      ]),
    );
    return Object.freeze({
      provider: "PAGARME",
      siteId: nomination.siteId,
      accountId: nomination.accountId,
      operationId: nomination.operationId,
      requestId: nomination.requestId,
      operatorUserId: nomination.operatorUserId,
      environment: nomination.environment,
      policyVersion: nomination.policyVersion,
      parentAccountReference: parent,
      fingerprintVersion: "hkdf-hmac-sha256-v1",
      fingerprintKeyId: id,
      inputFingerprint: createHmac("sha256", derived)
        .update(canonical)
        .digest("hex"),
    });
  } catch {
    return unavailable();
  } finally {
    root?.fill(0);
    derived?.fill(0);
    canonical?.fill(0);
  }
}
function authorizationFor(
  value: ReceivingNominationCurrentAuthorization,
  nomination: ReceivingNominationSnapshot,
): ReceivingNominationCurrentAuthorization {
  const actor = Object.freeze({ ...value.actor });
  const proof = value.recentAuth;
  if (
    actor.siteId !== nomination.siteId ||
    actor.userId !== nomination.operatorUserId ||
    !identifier(actor.sessionId) ||
    proof.userId !== actor.userId ||
    proof.siteId !== actor.siteId ||
    proof.sessionId !== actor.sessionId ||
    proof.provenance !== "backend" ||
    proof.verification !== "verified" ||
    ![
      "PASSWORD_REAUTHENTICATION",
      "MFA_REAUTHENTICATION",
      "SESSION_AUTHENTICATION",
    ].includes(proof.proofKind) ||
    !proof.authenticatedAt ||
    !proof.expiresAt
  )
    return unavailable();
  return Object.freeze({
    actor,
    recentAuth: Object.freeze({
      ...proof,
      authenticatedAt: readDatabaseTimestamp(proof.authenticatedAt),
      expiresAt: readDatabaseTimestamp(proof.expiresAt),
    }),
  });
}
function sameOriginal(
  left: ReceivingProvisioningRecord,
  right: ReceivingProvisioningRecord,
): boolean {
  return (
    isDeepStrictEqual(left.nomination, right.nomination) &&
    isDeepStrictEqual(left.provision, right.provision)
  );
}
function confirmed(
  observation: ReceivingProvisioningObservation | null,
  claim: ReceivingProvisioningRecord,
  result: ReceivingProvisioningResult,
): "UNKNOWN" | "SUCCEEDED" {
  if (
    !observation ||
    !sameOriginal(readReceivingProvisioningRecord(observation.record), claim) ||
    !isDeepStrictEqual(observation.result, result)
  )
    return unavailable();
  if (
    observation.state === "UNKNOWN" &&
    isDeepStrictEqual(observation.record.sealedResult, result)
  )
    return "UNKNOWN";
  if (
    observation.state === "SUCCEEDED" &&
    observation.record.sealedResult === null
  )
    return "SUCCEEDED";
  return unavailable();
}
export function createReceivingAccountProvisioning(options?: Options): {
  begin(command: ReceivingProvisioningCommand): ReceivingProvisioningOwner;
  close(): Promise<void>;
} {
  const keys = new Map<string, Uint8Array>();
  let configured = false;
  let repository: Options["repository"] | undefined;
  let readProvider: Options["readProvider"] | undefined;
  let now: Options["now"] | undefined;
  let activeKeyId: string | undefined;
  let generateId: NonNullable<Options["generateId"]> | undefined;
  let observe: NonNullable<Options["observe"]> = logObservabilityEvent;
  try {
    if (!options) return unavailable();
    const storedRepository = options.repository;
    const providerReader = options.readProvider;
    const clock = options.now;
    const fingerprintKeys = options.fingerprintKeys;
    const selectedKeyId = options.activeFingerprintKeyId;
    const idSource = options.generateId;
    const observer = options.observe;
    if (typeof observer === "function") observe = observer;
    if (
      storedRepository &&
      typeof providerReader === "function" &&
      typeof clock === "function" &&
      (idSource === undefined || typeof idSource === "function") &&
      fingerprintKeys instanceof Map &&
      fingerprintKeys.size <= 32
    ) {
      for (const [id, key] of fingerprintKeys) {
        if (!(key instanceof Uint8Array) || key.byteLength !== 32)
          return unavailable();
        keys.set(identifier(id), new Uint8Array(key));
      }
      activeKeyId = identifier(selectedKeyId);
      configured = keys.has(activeKeyId);
      repository = storedRepository;
      readProvider = providerReader;
      now = clock;
      generateId = idSource ?? (() => randomUUID());
    }
  } catch {
    configured = false;
  }
  let closing: Promise<void> | undefined;
  const owned = new Set<{
    abort: AbortController;
    completion: Promise<void>;
  }>();
  return Object.freeze({
    begin(command) {
      if (
        closing ||
        !configured ||
        !repository ||
        !readProvider ||
        !now ||
        !activeKeyId ||
        !generateId
      ) {
        const completion = Promise.resolve();
        return Object.freeze({
          feedback: Promise.resolve({ state: "UNAVAILABLE" as const }),
          completion,
          cancel: () => {},
        });
      }
      const abort = new AbortController();
      let resolveFeedback!: (value: Feedback) => void;
      const feedback = new Promise<Feedback>((resolve) => {
        resolveFeedback = resolve;
      });
      let settle!: () => void;
      const entry = {
        abort,
        completion: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      owned.add(entry);
      let nomination: ReceivingNominationSnapshot | undefined;
      let armAttempted = false;
      let spent = false;
      let settling = false;
      let stage: ReceivingProvisioningStage = "validate";
      let recipientInput: PagarmeRecipientInput | undefined;
      let verifyOnly = false;
      let verifyReason: ReceivingSetupReconcileReason | undefined;
      /** Why a verification stays UNKNOWN, from the stage that stopped it. */
      const reasonFor = (): ReceivingSetupReconcileReason =>
        verifyReason ??
        (stage === "consult_provider"
          ? "PROVIDER_UNREACHABLE"
          : stage === "release"
            ? "STATE_CHANGED"
            : "UNAVAILABLE");
      const recordFailure = (
        error: unknown,
        result: ReceivingProvisioningFailureEvent["result"],
      ) => {
        try {
          observe({
            level: "warn",
            event: "receiving.provisioning.failed",
            operation: stage,
            result,
            ...failureDetails(error, recipientInput),
            ...(nomination ? { siteId: nomination.siteId } : {}),
          });
        } catch {
          /* Logging never changes the provisioning outcome. */
        }
      };
      const report = (
        state: Feedback["state"],
        rejection?: ReceivingProviderRejection,
      ) =>
        resolveFeedback({
          state,
          ...(rejection ? { rejection } : {}),
          ...(verifyOnly && state === "UNKNOWN" ? { reason: reasonFor() } : {}),
          ...(nomination
            ? {
                siteId: nomination.siteId,
                requestId: nomination.requestId,
                accountId: nomination.accountId,
                operationId: nomination.operationId,
              }
            : {}),
        });
      const cancel = () => {
        abort.abort();
        report(armAttempted || settling ? "UNKNOWN" : "UNAVAILABLE");
      };
      const timer = setTimeout(cancel, 45000);
      const current = () => {
        if (closing || abort.signal.aborted) return unavailable();
      };
      void (async () => {
        try {
          current();
          nomination = readReceivingNominationSnapshot(command.nomination);
          if (
            command.confirmNativeCreation !== true ||
            !["CREATE", "SETTLE", "RECONCILE", "VERIFY"].includes(
              command.action,
            )
          )
            return unavailable();
          verifyOnly = command.action === "VERIFY";
          const settlement =
            command.action === "SETTLE"
              ? readReceivingProvisioningRecord(command.record)
              : null;
          const reconciliation =
            command.action === "RECONCILE" || command.action === "VERIFY"
              ? readReceivingProvisioningRecord(command.record)
              : null;
          settling = settlement !== null || reconciliation !== null;
          const authorization = authorizationFor(
            command.authorization,
            nomination,
          );
          // VERIFY carries no recipient input, so it can never create one.
          const input =
            command.action === "VERIFY"
              ? undefined
              : readReceivingRecipientInput(command.input);
          recipientInput = input;
          const requireInput = () => input ?? unavailable();
          if (
            reconciliation &&
            (!isDeepStrictEqual(reconciliation.nomination, nomination) ||
              !reconciliation.provision.dispatch.possibleDispatch ||
              reconciliation.sealedResult !== null)
          )
            return unavailable();
          // Absence can only be proven after the window, so a verification
          // before it does not even ask Pagar.me.
          if (
            verifyOnly &&
            reconciliation &&
            databaseTimestampEpochMicroseconds(now()) <
              BigInt(
                reconciliation.provision.dispatch.leaseExpiresAtMicroseconds,
              ) +
                RECEIVING_ABSENCE_GRACE_MICROSECONDS
          ) {
            verifyReason = "WINDOW_NOT_ELAPSED";
            report("UNKNOWN");
            return;
          }
          stage = "provider_check";
          const provider = await readProvider(nomination);
          current();
          if (
            provider?.approved !== true ||
            provider.environment !== nomination.environment ||
            provider.policyVersion !== nomination.policyVersion ||
            (!verifyOnly &&
              typeof provider.recipients?.createRecipient !== "function") ||
            (reconciliation &&
              typeof provider.recipients.findRecipientByCode !== "function")
          )
            return unavailable();
          const parent = identifier(provider.parentAccountReference);
          const recipients = provider.recipients;
          let claim: ReceivingProvisioningRecord | undefined;
          let prepared: ReceivingProvisioningResult | undefined;
          /** Seals the result; true once the account is already attached. */
          const quarantine = async (
            held: ReceivingProvisioningRecord,
            result: ReceivingProvisioningResult,
          ) => {
            stage = "quarantine";
            try {
              await repository.quarantineOriginal(held, result);
            } catch (error) {
              /* Consult only the original prepared result after commit uncertainty. */
              recordFailure(error, "recovering");
            }
            stage = "consult";
            return (
              confirmed(
                await repository.consultOriginal(held, result),
                held,
                result,
              ) === "SUCCEEDED"
            );
          };
          if (settlement) {
            claim = settlement;
            if (
              !isDeepStrictEqual(claim.nomination, nomination) ||
              !claim.provision.dispatch.possibleDispatch
            )
              return unavailable();
            const identity = deriveReceivingProvisioningContext(
              nomination,
              parent,
              claim.provision.fingerprintKeyId,
              requireInput(),
              keys,
            );
            const { dispatch: _dispatch, ...originalIdentity } =
              claim.provision;
            if (
              !timingSafeEqual(
                Buffer.from(identity.inputFingerprint, "hex"),
                Buffer.from(claim.provision.inputFingerprint, "hex"),
              ) ||
              !isDeepStrictEqual(identity, originalIdentity)
            )
              return unavailable();
            stage = "consult";
            const observation = await repository.consultOriginal(claim, null);
            current();
            if (
              !observation ||
              !sameOriginal(observation.record, claim) ||
              !observation.result ||
              (claim.sealedResult !== null &&
                !isDeepStrictEqual(claim.sealedResult, observation.result))
            )
              return unavailable();
            prepared = observation.result;
            if (confirmed(observation, claim, prepared) === "SUCCEEDED") {
              report("STORED");
              return;
            }
          } else {
            if (reconciliation) {
              claim = reconciliation;
              stage = "consult_provider";
              // GET only: a failed or partial read throws and stays UNKNOWN.
              const found = await recipients.findRecipientByCode(
                nomination.accountId,
              );
              current();
              if (found) {
                if (found.code !== nomination.accountId) return unavailable();
                prepared = readReceivingProvisioningResult({
                  accountReference: found.id,
                  recipientReference: found.id,
                });
                if (await quarantine(claim, prepared)) {
                  report("STORED");
                  return;
                }
              } else {
                stage = "release";
                await repository.releaseOriginal(claim, "PROVIDER_ABSENT");
                current();
                settling = false;
                if (verifyOnly) {
                  report("RELEASED");
                  return;
                }
              }
            }
          }
          if (!settlement && !prepared) {
            if (verifyOnly) return unavailable();
            const createInput = requireInput();
            const provision = deriveReceivingProvisioningContext(
              nomination,
              parent,
              activeKeyId,
              createInput,
              keys,
            );
            stage = "claim";
            claim = readReceivingProvisioningRecord(
              await repository.claimOriginal(
                {
                  nomination,
                  provision,
                  leaseOwner: identifier(generateId("owner")),
                  leaseToken: identifier(generateId("token")),
                },
                authorization,
              ),
            );
            current();
            const { dispatch, ...identity } = claim.provision;
            if (
              !isDeepStrictEqual(identity, provision) ||
              !isDeepStrictEqual(claim.nomination, nomination) ||
              dispatch.possibleDispatch ||
              claim.sealedResult !== null
            )
              return unavailable();
            claim = readReceivingProvisioningRecord({
              ...claim,
              provision: {
                ...claim.provision,
                dispatch: { ...dispatch, possibleDispatch: true },
              },
            });
            armAttempted = true;
            stage = "arm";
            try {
              await repository.armOriginal(claim, authorization);
            } catch (error) {
              recordFailure(error, "recovering");
              current();
              stage = "confirm_arm";
              await repository.confirmOriginalArmForDispatch(
                claim,
                authorization,
              );
            }
            current();
            if (
              spent ||
              databaseTimestampEpochMicroseconds(now()) >=
                BigInt(claim.provision.dispatch.leaseExpiresAtMicroseconds)
            )
              return unavailable();
            spent = true;
            stage = "create_recipient";
            // The account id is the recipient code; with the dispatch attempt
            // it keys idempotency, so a repeated request of one dispatch can
            // only return the same Pagar.me recipient.
            let recipient: Awaited<
              ReturnType<typeof recipients.createRecipient>
            >;
            try {
              recipient = await recipients.createRecipient(
                nomination.accountId,
                createInput,
                claim.provision.dispatch.attempt ?? 1,
              );
            } catch (error) {
              if (
                !(error instanceof PagarmeRejectedError) ||
                !DEFINITIVE_REJECTIONS.has(error.status)
              )
                throw error;
              // Nothing was created: release the dispatch for a corrected
              // submit. A failed release stays UNKNOWN until reconciled.
              recordFailure(error, "rejected");
              stage = "release";
              await repository.releaseOriginal(claim, "PROVIDER_REJECTED");
              report("REJECTED", describeRejection(error, createInput));
              return;
            }
            if (recipient.code !== nomination.accountId) return unavailable();
            prepared = readReceivingProvisioningResult({
              accountReference: recipient.id,
              recipientReference: recipient.id,
            });
            if (await quarantine(claim, prepared)) {
              report("STORED");
              return;
            }
          }
          if (!claim || !prepared) return unavailable();
          const held = claim;
          current();
          stage = "attach";
          try {
            await repository.attachOriginal(held, prepared, authorization);
          } catch (error) {
            /* No regenerated envelope or provider repeat follows an ambiguous commit. */
            recordFailure(error, "recovering");
          }
          stage = "consult";
          if (
            confirmed(
              await repository.consultOriginal(held, prepared),
              held,
              prepared,
            ) !== "SUCCEEDED"
          )
            return unavailable();
          report("STORED");
        } catch (error) {
          const outcome = armAttempted || settling ? "UNKNOWN" : "UNAVAILABLE";
          recordFailure(
            error,
            outcome === "UNKNOWN" ? "unknown" : "unavailable",
          );
          report(outcome);
        } finally {
          clearTimeout(timer);
          owned.delete(entry);
          settle();
        }
      })().catch(() => {
        report(armAttempted ? "UNKNOWN" : "UNAVAILABLE");
      });
      return Object.freeze({ feedback, completion: entry.completion, cancel });
    },
    close() {
      if (closing) return closing;
      let resolve!: () => void;
      closing = new Promise<void>((yes) => {
        resolve = yes;
      });
      for (const entry of owned) entry.abort.abort();
      void Promise.allSettled([...owned].map((entry) => entry.completion)).then(
        () => {
          for (const key of keys.values()) key.fill(0);
          resolve();
        },
      );
      return closing;
    },
  });
}
