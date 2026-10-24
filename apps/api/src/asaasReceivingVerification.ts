import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import { readAccountProvisioningInput } from "./asaasAccountProvisioningClient";
import {
  decryptProviderCredential,
  type ProviderCredentialKeyring,
} from "./providerCredentials";
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import { readReceivingProvisioningRecord } from "./receivingNomination";
import {
  createReceivingSetupAsaasObserver,
  type ReceivingSetupAsaasObservation,
} from "./receivingSetupAsaas";
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
  throw new Error("Native receiving verification unavailable");
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// These are authenticated-read identities and ordering, not provider event revisions.
export function prepareAsaasReceivingVerification(
  fence: ReceivingVerificationFence,
  observed: ReceivingSetupAsaasObservation,
  keyring: ProviderCredentialKeyring,
): {
  candidate: ReceivingVerificationCandidate;
  observation: ReceivingVerificationObservation | null;
} {
  const scope = fence.scope;
  const facts = observed.verificationFacts;
  const original = readReceivingProvisioningRecord(
    fence.operation.request_snapshot,
  );
  if (
    !["sandbox", "live"].includes(scope.environment) ||
    observed.environment !== scope.environment ||
    observed.siteId !== scope.siteId ||
    observed.accountBindingId !== scope.accountId ||
    observed.accountReference !== scope.accountReference ||
    observed.recipientReference !== scope.recipientReference ||
    original.nomination.siteId !== scope.siteId ||
    original.nomination.accountId !== scope.accountId ||
    original.nomination.operatorUserId !== scope.operatorUserId ||
    original.nomination.environment !== scope.environment ||
    !facts ||
    facts.activePixKey.status !== "ACTIVE"
  )
    return unavailable();
  const { status: commercialStatus, ...commercial } = facts.commercialInfo;
  const input = readAccountProvisioningInput(commercial);
  // Asaas can uppercase the legal name after KYC. Legacy fingerprints retain
  // the submitted case; every other field must still match the original HMAC.
  const lower = input.name.toLocaleLowerCase("pt-BR");
  const title = lower.replace(/(^|\s)(\p{L})/gu, (letter) =>
    letter.toLocaleUpperCase("pt-BR"),
  );
  const names = new Set([
    input.name,
    input.name.toLocaleUpperCase("pt-BR"),
    lower,
    title,
    title.replace(/\b(Da|Das|De|Do|Dos|E)\b/g, (word) =>
      word.toLocaleLowerCase("pt-BR"),
    ),
  ]);
  let identity:
    | ReturnType<typeof deriveReceivingProvisioningContext>
    | undefined;
  for (const name of names) {
    let candidate: ReturnType<typeof deriveReceivingProvisioningContext>;
    try {
      candidate = deriveReceivingProvisioningContext(
        original.nomination,
        original.provision.parentAccountReference,
        original.provision.fingerprintKeyId,
        { ...input, name },
        keyring,
      );
    } catch {
      continue;
    }
    if (
      timingSafeEqual(
        Buffer.from(candidate.inputFingerprint, "hex"),
        Buffer.from(original.provision.inputFingerprint, "hex"),
      )
    ) {
      identity = candidate;
      break;
    }
  }
  if (!identity) return unavailable();
  const bank = facts.accountNumber;
  for (const field of [bank.agency, bank.account, bank.accountDigit])
    if (typeof field !== "string" || !/^[0-9]{1,20}$/.test(field))
      return unavailable();
  const bankReference = `asaas-bank-${hash([scope.environment, scope.accountReference, bank.agency, bank.account, bank.accountDigit])}`;
  const boundScope = {
    ...scope,
    operatorReference:
      scope.operatorReference ?? `asaas-holder-${identity.inputFingerprint}`,
  };
  const source = `ar-${Buffer.from(hash([boundScope, identity.inputFingerprint, observed.status, bankReference, facts.activePixKey, observed.observedAt]), "hex").toString("base64url")}`;
  const candidate = readReceivingVerificationCandidate({
    kind: "DESTINATION",
    profile: "rv1",
    verifiable: true,
    scope: boundScope,
    bankReference,
    maskedDescriptor:
      bank.account.length >= 4 ? `Asaas **** ${bank.account.slice(-4)}` : null,
    mappingReference: source,
  });
  const current = fence.destinations.find(
    (destination) =>
      destination.is_current === true &&
      destination.bank_reference === bankReference,
  );
  if (!current) return { candidate, observation: null };
  const approved =
    (["commercialInfo", "documentation", "general"] as const).every(
      (key) => observed.status[key] === "APPROVED",
    ) &&
    commercialStatus === "APPROVED" &&
    observed.status.bankAccountInfo !== "REJECTED" &&
    observed.commercialInfoExpired !== true;
  const rejected = Object.values(observed.status).includes("REJECTED");
  const order = String(BigInt(Date.parse(observed.observedAt)) * 1000n);
  const observation: ReceivingVerificationObservation = {
    kind: "OBSERVATION",
    profile: "rv1",
    verifiable: true,
    scope: boundScope,
    destination: {
      id: String(current.id),
      version: Number(current.version),
      bankReference,
    },
    account: {
      sourceId: `${source}:account`,
      sourceOrder: order,
      state: approved ? "APPROVED" : rejected ? "BLOCKED" : "UNDER_REVIEW",
      observedAt: observed.observedAt,
      receiving: approved,
      withdrawal: approved,
      commercial: approved,
    },
    bank: {
      sourceId: `${source}:bank`,
      sourceOrder: order,
      state: approved
        ? "VERIFIED"
        : observed.status.bankAccountInfo === "REJECTED"
          ? "REJECTED"
          : "PENDING",
      observedAt: observed.observedAt,
    },
  };
  prepareReceivingVerificationObservation(observation);
  return { candidate, observation };
}

export function createAsaasReceivingVerification(options: {
  mode: "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  platformAccountReference: string;
  keyring: ProviderCredentialKeyring;
  fetch: typeof globalThis.fetch;
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
  const clients = new Set<
    ReturnType<typeof createReceivingSetupAsaasObserver>
  >();
  let closed = false;
  function active(scope: ReceivingVerificationFence["scope"]) {
    return (
      enabled &&
      !closed &&
      scope.environment === options.mode &&
      scope.accountReference !== options.platformAccountReference
    );
  }
  const observer: ReceivingVerificationObserver = {
    profile: "rv1",
    acquire(kind, fence, signal) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) abort.abort();
      const result = (async () => {
        if (!active(fence.scope) || abort.signal.aborted) return unavailable();
        const scope = fence.scope;
        const account = fence.account;
        const original = readReceivingProvisioningRecord(
          fence.operation.request_snapshot,
        );
        if (
          original.provision.parentAccountReference !==
          options.platformAccountReference
        )
          return unavailable();
        const context = {
          provider: "ASAAS" as const,
          siteId: scope.siteId,
          accountBindingId: scope.accountId,
          environment: options.mode,
        };
        const client = createReceivingSetupAsaasObserver({
          binding: {
            ...context,
            accountReference: scope.accountReference,
            recipientReference: scope.recipientReference,
          },
          accessToken: decryptProviderCredential(
            {
              version: account.credential_version,
              keyId: account.credential_key_id,
              nonce: account.credential_nonce,
              ciphertext: account.credential_ciphertext,
              tag: account.credential_tag,
            },
            context,
            options.keyring,
          ),
          fetch: options.fetch,
          now: options.now,
          includeVerificationFacts: true,
        });
        clients.add(client);
        try {
          const observed = await client.readStatus(abort.signal);
          const facts = prepareAsaasReceivingVerification(
            fence,
            observed,
            options.keyring,
          );
          if (!active(scope) || abort.signal.aborted) return unavailable();
          const at = options.now().getTime();
          for (const [id, proof] of proofs)
            if (at - proof.observedAt > 60000) proofs.delete(id);
          proofs.set(facts.candidate.mappingReference, {
            ...structuredClone(facts),
            observedAt: Date.parse(observed.observedAt),
          });
          if (kind === "SELECT") return facts.candidate;
          if (!facts.observation) return unavailable();
          return facts.observation;
        } finally {
          await client.close();
          clients.delete(client);
        }
      })();
      const completion = result
        .then(
          () => {},
          () => {},
        )
        .finally(() => signal.removeEventListener("abort", cancel));
      return { result, completion, cancel };
    },
    async close() {
      closed = true;
      await Promise.allSettled([...clients].map((client) => client.close()));
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
