import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type AccountProvisioningInput,
  type AsaasAccountProvisioningClient,
  readAccountProvisioningInput,
} from "./asaasAccountProvisioningClient";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type {
  ProviderCredentialContext,
  ProviderCredentialKeyring,
} from "./providerCredentials";
import {
  type ReceivingNominationCurrentAuthorization,
  type ReceivingNominationSnapshot,
  type ReceivingProvisioningContext,
  type ReceivingProvisioningRecord,
  type ReceivingProvisioningResult,
  readReceivingNominationSnapshot,
  readReceivingProvisioningRecord,
} from "./receivingNomination";

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
  readonly parentAccountReference: string;
  readonly policyVersion: string;
  createClient(
    context: ProviderCredentialContext,
  ): AsaasAccountProvisioningClient;
}
interface Options {
  repository: ReceivingAccountProvisioningRepository;
  readProvider(
    nomination: ReceivingNominationSnapshot,
  ): Promise<ReceivingProvisioningProvider | null>;
  fingerprintKeys: ProviderCredentialKeyring;
  activeFingerprintKeyId: string;
  now(): Date;
  generateId?(kind: "owner" | "token"): string;
}
export type ReceivingProvisioningCommand = {
  readonly nomination: ReceivingNominationSnapshot;
  readonly input: AccountProvisioningInput;
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
  input: AccountProvisioningInput,
  keyring: ProviderCredentialKeyring,
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
    const fields = readAccountProvisioningInput(input);
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
        "entrelacos.receiving-provisioning.input.v1",
        "hkdf-hmac-sha256-v1",
        id,
        "ASAAS",
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
        fields.cpfCnpj,
        fields.mobilePhone,
        fields.incomeValue,
        fields.address,
        fields.addressNumber,
        fields.province,
        fields.postalCode,
        fields.birthDate,
      ]),
    );
    return Object.freeze({
      provider: "ASAAS",
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
    !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
      proof.proofKind,
    ) ||
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
      let client: AsaasAccountProvisioningClient | undefined;
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
          const input = readAccountProvisioningInput(command.input);
          const provider = await readProvider(nomination);
          current();
          if (
            provider?.approved !== true ||
            provider.environment !== nomination.environment ||
            provider.policyVersion !== nomination.policyVersion ||
            typeof provider.createClient !== "function"
          )
            return unavailable();
          const parent = identifier(provider.parentAccountReference);
          client = provider.createClient({
            provider: "ASAAS",
            siteId: nomination.siteId,
            accountBindingId: nomination.accountId,
            environment: nomination.environment,
          });
          current();
          if (
            !client.available ||
            client.configuration?.parentAccountReference !== parent ||
            client.configuration.environment !== nomination.environment ||
            !isDeepStrictEqual(client.configuration.credentialContext, {
              provider: "ASAAS",
              siteId: nomination.siteId,
              accountBindingId: nomination.accountId,
              environment: nomination.environment,
            })
          )
            return unavailable();
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
            if (!client.credentialKeyIds.includes(prepared.credential.keyId))
              return unavailable();
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
            prepared = await client.createOriginal(input, abort.signal);
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
          try {
            await client?.close();
          } finally {
            clearTimeout(timer);
            owned.delete(entry);
            settle();
          }
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
