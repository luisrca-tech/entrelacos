import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { receivingPixDestinationReviewSchema } from "@entrelacos/contracts";
import type { ReceivingPixDestinationRecord } from "./receivingPixDestinationSetup";

export interface WithdrawalPayoutBinding {
  destinationId: string;
  destinationVersion: number;
  configurationHash: string;
  reviewId: string;
  holderId: string;
  holderConsentId: string;
  acceptThirdParty: boolean;
  keyType: "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP";
  maskedKey: string;
  ownerName: string;
}
function unavailable(): never {
  throw new TypeError("Reviewed withdrawal payout unavailable");
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    unavailable();
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export function readWithdrawalPayoutBinding(
  value: unknown,
): WithdrawalPayoutBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unavailable();
  const raw = value as Record<string, unknown>;
  const keys = [
    "destinationId",
    "destinationVersion",
    "configurationHash",
    "reviewId",
    "holderId",
    "holderConsentId",
    "acceptThirdParty",
    "keyType",
    "maskedKey",
    "ownerName",
  ];
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key)) ||
    !Number.isSafeInteger(raw.destinationVersion) ||
    (raw.destinationVersion as number) < 1 ||
    typeof raw.configurationHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.configurationHash) ||
    typeof raw.acceptThirdParty !== "boolean" ||
    !["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"].includes(String(raw.keyType))
  )
    unavailable();
  for (const key of [
    "destinationId",
    "reviewId",
    "holderId",
    "holderConsentId",
  ])
    id(raw[key]);
  for (const key of ["maskedKey", "ownerName"]) {
    if (
      typeof raw[key] !== "string" ||
      !(raw[key] as string).trim() ||
      (raw[key] as string).length > 120 ||
      [...(raw[key] as string)].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      unavailable();
  }
  if (!(raw.maskedKey as string).includes("***")) unavailable();
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, raw[key]])),
  ) as unknown as WithdrawalPayoutBinding;
}
export function sameWithdrawalPayout(
  left: WithdrawalPayoutBinding | undefined,
  right: WithdrawalPayoutBinding | undefined,
): boolean {
  return isDeepStrictEqual(left, right);
}
export function createWithdrawalPayoutBinding(
  scope: {
    siteId: string;
    accountId: string;
    accountReference: string;
    operatorUserId: string;
    environment: "sandbox" | "live";
    holderId: string;
    holderConsentId: string;
  },
  destination: ReceivingPixDestinationRecord,
  now: Date,
): WithdrawalPayoutBinding {
  const config = destination.configuration;
  if (
    config?.version !== 1 ||
    config.confirmRecipient !== true ||
    config.actor.siteId !== scope.siteId ||
    config.actor.userId !== scope.operatorUserId ||
    !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
      config.proofKind,
    ) ||
    !Number.isFinite(Date.parse(config.authenticatedAt)) ||
    Date.parse(config.authenticatedAt) > now.getTime()
  )
    unavailable();
  const review = receivingPixDestinationReviewSchema
    .omit({ reviewToken: true, expiresAt: true })
    .parse(config.review);
  if (
    review.siteId !== scope.siteId ||
    review.mode !== scope.environment ||
    Date.parse(review.observedAt) > now.getTime() ||
    (review.identity !== "MATCH" && config.acceptThirdParty !== true)
  )
    unavailable();
  return readWithdrawalPayoutBinding({
    destinationId: destination.id,
    destinationVersion: destination.version,
    configurationHash: createHash("sha256")
      .update(canonical(config))
      .digest("hex"),
    reviewId: config.reviewId,
    holderId: scope.holderId,
    holderConsentId: scope.holderConsentId,
    acceptThirdParty: config.acceptThirdParty,
    keyType: review.keyType,
    maskedKey: review.maskedKey,
    ownerName: review.ownerName,
  });
}
