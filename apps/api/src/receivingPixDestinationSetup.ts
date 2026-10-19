import { hkdfSync, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ReceivingPixDestinationInput,
  type ReceivingPixDestinationReview,
  receivingPixDestinationInputSchema,
} from "@entrelacos/contracts";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKeyring,
} from "./providerCredentials";
import type { ReceivingSetupAccountRecord } from "./receivingSetupRepository";

export type ReceivingPixReviewFacts = Omit<
  ReceivingPixDestinationReview,
  "reviewToken" | "expiresAt"
>;
export interface ReceivingPixDestinationScope {
  provider: "ASAAS";
  siteId: string;
  accountId: string;
  accountReference: string;
  recipientReference: string;
  operatorUserId: string;
  environment: "sandbox" | "live";
  destinationVersion: number;
  membershipId: string | null;
  holderId: string;
  consentId: string | null;
}
export interface ReceivingPixConfiguration {
  version: 1;
  reviewId: string;
  key: ProviderCredentialEnvelope;
  review: ReceivingPixReviewFacts;
  actor: FinancialActor;
  authenticatedAt: string;
  proofKind: RecentFinancialAuthenticationEvidence["proofKind"];
  confirmRecipient: true;
  acceptThirdParty: boolean;
}
export interface ReceivingPixDestinationRecord {
  id: string;
  version: number;
  configuration: ReceivingPixConfiguration | null;
}
export interface ReceivingPixDestinationSnapshot {
  scope: ReceivingPixDestinationScope;
  current: ReceivingPixDestinationRecord | null;
}
export interface ReceivingPixDestinationSave {
  actor: FinancialActor;
  recentAuth: RecentFinancialAuthenticationEvidence;
  scope: ReceivingPixDestinationScope;
  expiresAt: Date;
  configuration: ReceivingPixConfiguration;
}
export interface ReceivingPixDestinationSetupRepository {
  snapshot(
    actor: FinancialActor,
    readOnly?: boolean,
  ): Promise<ReceivingPixDestinationSnapshot>;
  save(
    command: ReceivingPixDestinationSave,
  ): Promise<ReceivingPixDestinationRecord>;
}
export class ReceivingPixDestinationSetupError extends Error {
  constructor(
    readonly status: 403 | 409 | 503 = 409,
    readonly code = "PIX_DESTINATION_REVIEW_INVALID",
  ) {
    super("Pix destination configuration unavailable");
  }
}
function reject(code?: string, status: 403 | 409 | 503 = 409): never {
  throw new ReceivingPixDestinationSetupError(status, code);
}
function time(value: Date): number {
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    value.getTime() < 0
  )
    return reject();
  return value.getTime();
}
export function assertReceivingPixSetupProof(
  actor: FinancialActor,
  proof: RecentFinancialAuthenticationEvidence,
  now: Date,
  maxAge = 300000,
): asserts proof is RecentFinancialAuthenticationEvidence & {
  authenticatedAt: Date;
  expiresAt: Date;
} {
  if (
    !proof ||
    proof.userId !== actor.userId ||
    proof.siteId !== actor.siteId ||
    proof.sessionId !== actor.sessionId ||
    proof.provenance !== "backend" ||
    proof.verification !== "verified" ||
    !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
      proof.proofKind,
    ) ||
    !(proof.authenticatedAt instanceof Date) ||
    !(proof.expiresAt instanceof Date)
  )
    return reject("RECENT_AUTH_REQUIRED", 403);
  const authenticated = time(proof.authenticatedAt),
    expires = time(proof.expiresAt),
    current = time(now);
  if (
    authenticated > current ||
    current - authenticated > maxAge ||
    expires <= current ||
    expires <= authenticated ||
    expires - authenticated > 300000
  )
    return reject("RECENT_AUTH_REQUIRED", 403);
}
const duration = 300000;
interface Receipt {
  purpose: "receiving-pix-review.v1";
  actor: FinancialActor;
  scope: ReceivingPixDestinationScope;
  input: ReceivingPixDestinationInput;
  review: ReceivingPixReviewFacts;
  reviewId: string;
  issuedAt: number;
  expiresAt: number;
}
function context(scope: ReceivingPixDestinationScope) {
  return {
    provider: "ASAAS" as const,
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    environment: scope.environment,
  };
}
function publicFacts(review: ReceivingPixReviewFacts): ReceivingPixReviewFacts {
  return {
    siteId: review.siteId,
    mode: review.mode,
    keyType: review.keyType,
    maskedKey: review.maskedKey,
    ownerName: review.ownerName,
    maskedCpfCnpj: review.maskedCpfCnpj,
    bankName: review.bankName,
    identity: review.identity,
    observedAt: review.observedAt,
    destinationSaved: false,
    withdrawalEnabled: false,
  };
}
function saved(record: ReceivingPixDestinationRecord) {
  if (!record.configuration) return null;
  const {
    destinationSaved: _saved,
    observedAt: _observed,
    ...review
  } = record.configuration.review;
  return {
    ...review,
    destinationId: record.id,
    version: record.version,
    state: "PENDING" as const,
    withdrawalEnabled: false as const,
  };
}
export function createReceivingPixDestinationSetup(options: {
  repository: ReceivingPixDestinationSetupRepository;
  mode: "sandbox" | "live";
  keyring: ProviderCredentialKeyring;
  keyId: string;
  now(): Date;
  generateId?(): string;
}) {
  const derive = (purpose: string) =>
    new Map(
      [...options.keyring].map(([id, key]) => [
        id,
        new Uint8Array(
          hkdfSync(
            "sha256",
            key,
            "entrelacos.receiving-pix-destination.v1",
            purpose,
            32,
          ),
        ),
      ]),
    );
  const reviewKeys = derive("review"),
    destinationKeys = derive("destination");
  const generateId = options.generateId ?? randomUUID;
  return Object.freeze({
    async issueReview(
      actor: FinancialActor,
      account: ReceivingSetupAccountRecord,
      rawInput: ReceivingPixDestinationInput,
      rawReview: ReceivingPixReviewFacts,
    ) {
      const input = receivingPixDestinationInputSchema.safeParse(rawInput);
      const state = await options.repository.snapshot(actor);
      const scope = state.scope,
        review = publicFacts(rawReview),
        issuedAt = time(options.now());
      if (
        !input.success ||
        scope.environment !== options.mode ||
        scope.siteId !== actor.siteId ||
        scope.operatorUserId !== actor.userId ||
        scope.accountId !== account.accountId ||
        account.operatorUserId !== actor.userId ||
        account.state !== "SUCCEEDED" ||
        scope.accountReference !== account.result?.accountReference ||
        scope.recipientReference !== account.result?.recipientReference ||
        review.siteId !== actor.siteId ||
        review.mode !== options.mode ||
        review.keyType !== input.data.type ||
        !["MATCH", "MISMATCH", "INCOMPLETE"].includes(review.identity) ||
        !review.maskedKey.includes("*") ||
        !review.maskedCpfCnpj.includes("*") ||
        review.maskedKey.includes(input.data.key) ||
        !Number.isFinite(Date.parse(review.observedAt)) ||
        Date.parse(review.observedAt) > issuedAt ||
        issuedAt - Date.parse(review.observedAt) > duration
      )
        return reject();
      const receipt: Receipt = {
        purpose: "receiving-pix-review.v1",
        actor: { ...actor },
        scope: { ...scope },
        input: input.data,
        review,
        reviewId: generateId(),
        issuedAt,
        expiresAt: issuedAt + duration,
      };
      const envelope = encryptProviderCredential(
        JSON.stringify(receipt),
        context(scope),
        reviewKeys,
        options.keyId,
      );
      return {
        reviewToken: Buffer.from(JSON.stringify(envelope)).toString(
          "base64url",
        ),
        expiresAt: new Date(receipt.expiresAt).toISOString(),
      };
    },
    async confirm(
      actor: FinancialActor,
      input: {
        reviewToken: string;
        confirmRecipient: true;
        acceptThirdParty?: true;
      },
      recentAuth: RecentFinancialAuthenticationEvidence,
    ) {
      assertReceivingPixSetupProof(actor, recentAuth, options.now());
      const state = await options.repository.snapshot(actor);
      let receipt: Receipt;
      try {
        if (
          typeof input.reviewToken !== "string" ||
          input.reviewToken.length > 16384 ||
          !/^[A-Za-z0-9_-]+$/.test(input.reviewToken)
        )
          return reject();
        const buffer = Buffer.from(input.reviewToken, "base64url");
        if (buffer.toString("base64url") !== input.reviewToken) return reject();
        receipt = JSON.parse(
          decryptProviderCredential(
            JSON.parse(buffer.toString("utf8")),
            context(state.scope),
            reviewKeys,
          ),
        );
      } catch {
        return reject();
      }
      const current = time(options.now());
      const { destinationVersion: expectedVersion, ...binding } =
        receipt.scope ?? {};
      const { destinationVersion: currentVersion, ...actualBinding } =
        state.scope;
      if (
        receipt.purpose !== "receiving-pix-review.v1" ||
        !isDeepStrictEqual(receipt.actor, actor) ||
        !isDeepStrictEqual(binding, actualBinding) ||
        receipt.scope.environment !== options.mode ||
        !Number.isSafeInteger(receipt.issuedAt) ||
        !Number.isSafeInteger(receipt.expiresAt) ||
        receipt.issuedAt > current ||
        receipt.expiresAt <= current ||
        receipt.expiresAt - receipt.issuedAt !== duration ||
        (expectedVersion !== currentVersion &&
          state.current?.configuration?.reviewId !== receipt.reviewId)
      )
        return reject();
      if (
        input.confirmRecipient !== true ||
        (receipt.review.identity !== "MATCH" && input.acceptThirdParty !== true)
      )
        return reject("PIX_RECIPIENT_CONFIRMATION_REQUIRED");
      const configuration: ReceivingPixConfiguration = {
        version: 1,
        reviewId: receipt.reviewId,
        key: encryptProviderCredential(
          JSON.stringify({ purpose: "receiving-pix-key.v1", ...receipt.input }),
          context(receipt.scope),
          destinationKeys,
          options.keyId,
        ),
        review: receipt.review,
        actor: { ...actor },
        authenticatedAt: recentAuth.authenticatedAt.toISOString(),
        proofKind: recentAuth.proofKind,
        confirmRecipient: true,
        acceptThirdParty: input.acceptThirdParty === true,
      };
      const record = await options.repository.save({
        actor: { ...actor },
        recentAuth,
        scope: receipt.scope,
        expiresAt: new Date(receipt.expiresAt),
        configuration,
      });
      const output = saved(record);
      if (!output) return reject();
      return output;
    },
    async read(actor: FinancialActor) {
      return saved(
        (await options.repository.snapshot(actor, true)).current ?? {
          id: "",
          version: 0,
          configuration: null,
        },
      );
    },
    close() {
      for (const key of [...reviewKeys.values(), ...destinationKeys.values()])
        key.fill(0);
      reviewKeys.clear();
      destinationKeys.clear();
    },
  });
}
