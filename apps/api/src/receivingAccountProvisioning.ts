import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { receivingSetupAccountSchema } from "@entrelacos/contracts";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type {
  PagarmeRecipientClient,
  PagarmeRecipientInput,
} from "./pagarmeRecipientClient";
import {
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
}
export interface ReceivingProvisioningProvider {
  readonly approved: true;
  readonly environment: "sandbox" | "live";
  /** The platform Pagar.me recipient that receives the platform split. */
  readonly parentAccountReference: string;
  readonly policyVersion: string;
  readonly recipients: Pick<PagarmeRecipientClient, "createRecipient">;
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
}
export type ReceivingProvisioningCommand = {
  readonly nomination: ReceivingNominationSnapshot;
  readonly input: PagarmeRecipientInput;
  readonly authorization: ReceivingNominationCurrentAuthorization;
  readonly confirmNativeCreation: true;
} & (
  | { readonly action: "CREATE" }
  | { readonly action: "SETTLE"; readonly record: ReceivingProvisioningRecord }
);
interface Feedback {
  readonly state: "UNAVAILABLE" | "UNKNOWN" | "STORED";
  readonly siteId?: string;
  readonly requestId?: string;
  readonly accountId?: string;
  readonly operationId?: string;
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
        "entrelacos.receiving-provisioning.input.v2",
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
        address.referencePoint,
        bank.bank,
        bank.branchNumber,
        bank.branchCheckDigit ?? null,
        bank.accountNumber,
        bank.accountCheckDigit,
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
  try {
    if (!options) return unavailable();
    const storedRepository = options.repository;
    const providerReader = options.readProvider;
    const clock = options.now;
    const fingerprintKeys = options.fingerprintKeys;
    const selectedKeyId = options.activeFingerprintKeyId;
    const idSource = options.generateId;
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
      const report = (state: Feedback["state"]) =>
        resolveFeedback({
          state,
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
            !["CREATE", "SETTLE"].includes(command.action)
          )
            return unavailable();
          const settlement =
            command.action === "SETTLE"
              ? readReceivingProvisioningRecord(command.record)
              : null;
          settling = settlement !== null;
          const authorization = authorizationFor(
            command.authorization,
            nomination,
          );
          const input = readReceivingRecipientInput(command.input);
          const provider = await readProvider(nomination);
          current();
          if (
            provider?.approved !== true ||
            provider.environment !== nomination.environment ||
            provider.policyVersion !== nomination.policyVersion ||
            typeof provider.recipients?.createRecipient !== "function"
          )
            return unavailable();
          const parent = identifier(provider.parentAccountReference);
          const recipients = provider.recipients;
          let claim: ReceivingProvisioningRecord;
          let prepared: ReceivingProvisioningResult;
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
              input,
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
            const provision = deriveReceivingProvisioningContext(
              nomination,
              parent,
              activeKeyId,
              input,
              keys,
            );
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
            try {
              await repository.armOriginal(claim, authorization);
            } catch {
              current();
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
            // The account id is the recipient code and idempotency key, so a
            // repeated request can only return the same Pagar.me recipient.
            const recipient = await recipients.createRecipient(
              nomination.accountId,
              input,
            );
            if (recipient.code !== nomination.accountId) return unavailable();
            prepared = readReceivingProvisioningResult({
              accountReference: recipient.id,
              recipientReference: recipient.id,
            });
            try {
              await repository.quarantineOriginal(claim, prepared);
            } catch {
              /* Consult only the original prepared result after commit uncertainty. */
            }
            if (
              confirmed(
                await repository.consultOriginal(claim, prepared),
                claim,
                prepared,
              ) === "SUCCEEDED"
            ) {
              report("STORED");
              return;
            }
          }
          current();
          try {
            await repository.attachOriginal(claim, prepared, authorization);
          } catch {
            /* No regenerated envelope or provider repeat follows an ambiguous commit. */
          }
          if (
            confirmed(
              await repository.consultOriginal(claim, prepared),
              claim,
              prepared,
            ) !== "SUCCEEDED"
          )
            return unavailable();
          report("STORED");
        } catch {
          report(armAttempted || settling ? "UNKNOWN" : "UNAVAILABLE");
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
