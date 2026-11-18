import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import {
  mapPagarmeRecipientStatus,
  type PagarmeRecipient,
  type PagarmeRecipientClient,
} from "./pagarmeRecipientClient";
import { readReceivingProvisioningRecord } from "./receivingNomination";
import {
  prepareReceivingVerificationObservation,
  type ReceivingVerificationCandidate,
  type ReceivingVerificationFence,
  type ReceivingVerificationObservation,
  type ReceivingVerificationObserver,
  readReceivingVerificationCandidate,
} from "./receivingVerification";
import type { ReceivingVerificationRepositoryOptions } from "./receivingVerificationRepository";

function unavailable(): never {
  throw new Error("Pagar.me receiving verification unavailable");
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/**
 * Maps one authenticated recipient read onto the stored receiving binding.
 * The recipient default bank account is the only destination candidate.
 */
export function preparePagarmeReceivingVerification(
  fence: ReceivingVerificationFence,
  recipient: PagarmeRecipient,
  observedAt: string,
): {
  candidate: ReceivingVerificationCandidate;
  observation: ReceivingVerificationObservation | null;
} {
  const scope = fence.scope;
  const original = readReceivingProvisioningRecord(
    fence.operation.request_snapshot,
  );
  const bank = recipient.bankAccount;
  if (
    !["sandbox", "live"].includes(scope.environment) ||
    recipient.id !== scope.recipientReference ||
    recipient.id !== scope.accountReference ||
    recipient.code !== scope.accountId ||
    original.nomination.siteId !== scope.siteId ||
    original.nomination.accountId !== scope.accountId ||
    original.nomination.operatorUserId !== scope.operatorUserId ||
    original.nomination.environment !== scope.environment ||
    !bank
  )
    return unavailable();
  const boundScope = {
    ...scope,
    operatorReference:
      scope.operatorReference ??
      `pagarme-holder-${original.provision.inputFingerprint}`,
  };
  const source = `pr-${hash([boundScope, recipient.status, recipient.document ?? null, bank, observedAt])}`;
  const candidate = readReceivingVerificationCandidate({
    kind: "DESTINATION",
    profile: "rv1",
    verifiable: true,
    scope: boundScope,
    bankReference: bank.id,
    maskedDescriptor: bank.maskedAccount,
    mappingReference: source,
  });
  const current = fence.destinations.find(
    (destination) =>
      destination.is_current === true && destination.bank_reference === bank.id,
  );
  if (!current) return { candidate, observation: null };
  const mapped = mapPagarmeRecipientStatus(recipient.status);
  const approved = mapped.providerAccountState === "APPROVED";
  const holderKnown = typeof recipient.document === "string";
  const ownBank = holderKnown && bank.holderDocument === recipient.document;
  const bankState =
    holderKnown && !ownBank
      ? "REJECTED"
      : approved && ownBank
        ? "VERIFIED"
        : "PENDING";
  const order = String(BigInt(Date.parse(observedAt)) * 1000n);
  const observation: ReceivingVerificationObservation = {
    kind: "OBSERVATION",
    profile: "rv1",
    verifiable: true,
    scope: boundScope,
    destination: {
      id: String(current.id),
      version: Number(current.version),
      bankReference: bank.id,
    },
    account: {
      sourceId: `${source}:account`,
      sourceOrder: order,
      state: mapped.providerAccountState,
      observedAt,
      receiving: mapped.receivingCapability,
      // Withdrawals also need the recipient's own, verified bank account.
      withdrawal: mapped.withdrawalCapability && bankState === "VERIFIED",
      commercial: mapped.receivingCapability,
    },
    bank: {
      sourceId: `${source}:bank`,
      sourceOrder: order,
      state: bankState,
      observedAt,
    },
  };
  prepareReceivingVerificationObservation(observation);
  return { candidate, observation };
}

export function createPagarmeReceivingVerification(options: {
  mode: "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  platformRecipientId: string;
  recipients: Pick<PagarmeRecipientClient, "getRecipient">;
  now(): Date;
}) {
  const enabled =
    (options.mode === "sandbox" &&
      options.applicationEnvironment === "development") ||
    (options.mode === "live" &&
      options.applicationEnvironment === "production");
  const proofs = new Map<
    string,
    {
      candidate: ReceivingVerificationCandidate;
      observation: ReceivingVerificationObservation | null;
      observedAt: number;
    }
  >();
  let closed = false;
  function active(scope: ReceivingVerificationFence["scope"]) {
    return (
      enabled &&
      !closed &&
      scope.environment === options.mode &&
      scope.accountReference !== options.platformRecipientId &&
      scope.recipientReference !== options.platformRecipientId
    );
  }
  const observer: ReceivingVerificationObserver = {
    profile: "rv1",
    acquire(kind, fence, signal) {
      const result = (async () => {
        if (!active(fence.scope) || signal.aborted) return unavailable();
        const original = readReceivingProvisioningRecord(
          fence.operation.request_snapshot,
        );
        if (
          original.provision.parentAccountReference !==
          options.platformRecipientId
        )
          return unavailable();
        const recipient = await options.recipients.getRecipient(
          fence.scope.recipientReference,
        );
        if (!active(fence.scope) || signal.aborted) return unavailable();
        const observedAt = options.now().toISOString();
        const facts = preparePagarmeReceivingVerification(
          fence,
          recipient,
          observedAt,
        );
        const at = options.now().getTime();
        for (const [id, proof] of proofs)
          if (at - proof.observedAt > 60000) proofs.delete(id);
        proofs.set(facts.candidate.mappingReference, {
          ...structuredClone(facts),
          observedAt: Date.parse(observedAt),
        });
        if (kind === "SELECT") return facts.candidate;
        if (!facts.observation) return unavailable();
        return facts.observation;
      })();
      const completion = result.then(
        () => {},
        () => {},
      );
      return { result, completion, cancel: () => {} };
    },
    async close() {
      closed = true;
      proofs.clear();
    },
  };
  const readCurrentPolicy: NonNullable<
    ReceivingVerificationRepositoryOptions["readCurrentPolicy"]
  > = async (_action, fence, tx, value) => {
    if (!active(fence.scope)) return false;
    const holder = await tx.execute(
      sql`SELECT holder_user_id AS "holderUserId",consent_id AS "consentId",consent_version AS "consentVersion",consent_at AS "consentAt" FROM receiving_setup_holder WHERE site_id=${fence.scope.siteId} AND environment=${options.mode} FOR UPDATE`,
    );
    const row = holder.rows[0];
    if (
      holder.rows.length !== 1 ||
      row.holderUserId !== fence.scope.operatorUserId ||
      !row.consentId ||
      row.consentVersion !== receivingSetupConsentVersion ||
      !row.consentAt
    )
      return false;
    const consentTime = Date.parse(
      row.consentAt instanceof Date
        ? row.consentAt.toISOString()
        : String(row.consentAt),
    );
    if (
      !Number.isSafeInteger(consentTime) ||
      consentTime > options.now().getTime()
    )
      return false;
    if (value === null) return true;
    const source =
      value.kind === "DESTINATION"
        ? value.mappingReference
        : value.account.sourceId.replace(/:account$/, "");
    const proof = proofs.get(source);
    const at = options.now().getTime();
    if (
      !proof ||
      !Number.isSafeInteger(at) ||
      proof.observedAt > at ||
      at - proof.observedAt > 60000
    )
      return false;
    return value.kind === "DESTINATION"
      ? isDeepStrictEqual(value, proof.candidate)
      : proof.observation !== null &&
          isDeepStrictEqual(
            value,
            prepareReceivingVerificationObservation(proof.observation),
          );
  };
  return Object.freeze({
    observer,
    readCurrentPolicy,
    readObserverPolicy: async (scope: ReceivingVerificationFence["scope"]) =>
      active(scope),
  });
}
