import {
  type AsaasHttpClient,
  type AsaasTransferObservation,
  readAsaasTransferEffectiveDate,
} from "./asaasHttpClient";
import { parseBrlCents } from "./giftMoney";
import { logWithdrawalFailure } from "./withdrawalDiagnostics";
import {
  captureDispatchFence,
  captureOriginalWithdrawal,
  captureWithdrawalValue,
  type DispatchFence,
  type OriginalWithdrawal,
  type WithdrawalDispatchObservation,
  type WithdrawalDispatchPort,
  type WithdrawalLookupPort,
  withdrawalInstant,
} from "./withdrawalExecution";
import {
  sameWithdrawalPayout,
  type WithdrawalPayoutBinding,
} from "./withdrawalPayout";

export interface AsaasWithdrawalDestination {
  payout?: WithdrawalPayoutBinding;
  siteId: string;
  accountId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  recipientReference: string;
  bankReference: string;
  destinationVersion: number;
  pixAddressKey: string;
  pixAddressKeyType: "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP";
  provenance: "provider";
  verification: "verified";
}
export interface AsaasWithdrawalCustody {
  record(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    observation: AsaasTransferObservation,
  ): Promise<string>;
}
export type AsaasWithdrawalTransferClient = Pick<
  AsaasHttpClient,
  "createPixTransfer" | "getTransfer" | "listTransfers"
>;
export interface AsaasWithdrawalTransferAdapterOptions {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  now(): Date;
  // The composition must load the reviewed external Pix destination under the
  // frozen consent and dispatch fence, not the account's incoming bank reference.
  loadDestination(
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ): Promise<AsaasWithdrawalDestination | null>;
  loadClient(
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ): Promise<AsaasWithdrawalTransferClient>;
  custody: AsaasWithdrawalCustody;
}
function unavailable(): never {
  throw new TypeError("Native withdrawal transfer unavailable");
}

// Live gross-budget consent uses the provider net amount after its observed transfer fee.
export function captureAsaasWithdrawalTransfer(
  original: OriginalWithdrawal,
  input: AsaasTransferObservation,
  now: Date,
): AsaasTransferObservation {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailable();
  const observation = captureWithdrawalValue(input);
  const c = original.correlation;
  const t = observation.transfer;
  if (typeof t.netValue !== "string" || typeof t.transferFee !== "string")
    unavailable();
  const minimumNet =
    original.snapshot.feeQuote.feeSemantics === "MAXIMUM_WITH_MINIMUM_NET";
  const value = parseBrlCents(t.value);
  const net = parseBrlCents(t.netValue);
  const fee = parseBrlCents(t.transferFee);
  if (
    observation.source !== "provider" ||
    observation.provider !== "ASAAS" ||
    observation.siteId !== c.siteId ||
    observation.accountBindingId !== c.accountId ||
    observation.accountReference !== c.accountReference ||
    observation.environment !== c.environment ||
    !["sandbox", "live"].includes(c.environment) ||
    (minimumNet && c.environment !== "live") ||
    (!minimumNet &&
      original.snapshot.feeQuote.feeSemantics !== "MAXIMUM" &&
      c.feeCents !== 0) ||
    c.amountCents !== c.netCents + c.feeCents ||
    t.externalReference !== c.operationId ||
    t.operationType !== "PIX" ||
    !["PIX", "BANK_ACCOUNT"].includes(t.type) ||
    (minimumNet
      ? value !== c.amountCents ||
        net < c.netCents ||
        fee > c.feeCents ||
        value !== net + fee
      : value !== c.netCents || net !== value || fee !== 0) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(t.id) ||
    !["PENDING", "BANK_PROCESSING", "DONE", "FAILED", "CANCELLED"].includes(
      t.status,
    ) ||
    new Date(withdrawalInstant(observation.observedAt)).getTime() >
      now.getTime() ||
    new Date(withdrawalInstant(observation.observedAt)).getTime() <
      new Date(original.snapshot.intent.createdAt).getTime()
  )
    unavailable();
  if (
    t.status === "DONE" &&
    (!t.transactionReceiptUrl ||
      !/^https:\/\//.test(t.transactionReceiptUrl) ||
      !t.endToEndIdentifier ||
      !/^[\x21-\x7e]{1,256}$/.test(t.endToEndIdentifier) ||
      !readAsaasTransferEffectiveDate(t.effectiveDate))
  )
    unavailable();
  return observation;
}

export function createAsaasWithdrawalTransferAdapter(
  options: AsaasWithdrawalTransferAdapterOptions,
): WithdrawalDispatchPort & WithdrawalLookupPort {
  const mode = options.mode;
  const applicationEnvironment = options.applicationEnvironment;
  const now = options.now;
  const loadDestination = options.loadDestination;
  const loadClient = options.loadClient;
  const record = options.custody.record.bind(options.custody);
  function inputs(
    originalInput: OriginalWithdrawal,
    fenceInput: DispatchFence,
  ) {
    const original = captureOriginalWithdrawal(originalInput);
    const fence = captureDispatchFence(fenceInput, original);
    if (
      !(
        (mode === "sandbox" &&
          ["development", "test"].includes(applicationEnvironment)) ||
        (mode === "live" && applicationEnvironment === "production")
      ) ||
      original.correlation.environment !== mode ||
      (original.correlation.feeCents !== 0 &&
        original.snapshot.feeQuote.feeSemantics !== "MAXIMUM" &&
        original.snapshot.feeQuote.feeSemantics !== "MAXIMUM_WITH_MINIMUM_NET")
    )
      unavailable();
    return { original, fence };
  }
  async function observe(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    input: AsaasTransferObservation,
  ): Promise<WithdrawalDispatchObservation> {
    const captured = captureAsaasWithdrawalTransfer(original, input, now());
    // Authorization fingerprints native routing; completion custody never retains its plaintext.
    const { bankAccount: _bankAccount, ...transfer } = captured.transfer;
    const observation = { ...captured, transfer };
    const reference = await record(original, fence, observation);
    if (!/^asaas-transfer:[a-f0-9]{64}$/.test(reference)) unavailable();
    const identity = {
      correlation: original.correlation,
      holderBinding: original.holderBinding,
      fence,
    };
    if (["FAILED", "CANCELLED"].includes(observation.transfer.status))
      return {
        ...identity,
        outcome: "REJECTED",
        reason: `ASAAS_TRANSFER_${observation.transfer.status}`,
        proofReference: reference,
        providerReference: observation.transfer.id,
        observedAt: withdrawalInstant(observation.observedAt),
      };
    return {
      ...identity,
      outcome: "ACCEPTED",
      providerReference: observation.transfer.id,
      observedAt: withdrawalInstant(observation.observedAt),
      proofReference: observation.transfer.status === "DONE" ? reference : null,
    };
  }
  return {
    async dispatch(originalInput, fenceInput) {
      const unresolved = {
        outcome: "UNRESOLVED" as const,
        correlation: originalInput.correlation,
        holderBinding: originalInput.holderBinding,
        fence: fenceInput,
      };
      try {
        const { original, fence } = inputs(originalInput, fenceInput);
        if (new Date(fence.leaseExpiresAt).getTime() <= now().getTime())
          unavailable();
        const destination = captureWithdrawalValue(
          await loadDestination(original, fence),
        );
        const c = original.correlation;
        if (
          destination?.provenance !== "provider" ||
          !sameWithdrawalPayout(
            destination.payout,
            original.consent.snapshot.presentation.payout,
          ) ||
          destination.verification !== "verified" ||
          [
            "siteId",
            "accountId",
            "accountReference",
            "environment",
            "recipientReference",
            "bankReference",
            "destinationVersion",
          ].some(
            (key) =>
              (destination as unknown as Record<string, unknown>)[key] !==
              (c as unknown as Record<string, unknown>)[key],
          )
        )
          unavailable();
        const client = await loadClient(original, fence);
        if (new Date(fence.leaseExpiresAt).getTime() <= now().getTime())
          unavailable();
        const observation = await client.createPixTransfer({
          valueCents:
            original.snapshot.feeQuote.feeSemantics ===
            "MAXIMUM_WITH_MINIMUM_NET"
              ? c.amountCents
              : c.netCents,
          pixAddressKey: destination.pixAddressKey,
          pixAddressKeyType: destination.pixAddressKeyType,
          externalReference: c.operationId,
        });
        return await observe(original, fence, observation);
      } catch (error) {
        logWithdrawalFailure(error);
        return unresolved;
      }
    },
    async lookup(originalInput, fenceInput, providerReference) {
      try {
        const { original, fence } = inputs(originalInput, fenceInput);
        const client = await loadClient(original, fence);
        let found: AsaasTransferObservation | null = null;
        if (providerReference !== null) {
          found = await client.getTransfer(providerReference);
          if (found.transfer.id !== providerReference) unavailable();
        } else {
          const seen = new Set<string>();
          let total: number | null = null;
          for (let offset = 0; offset < 1000; offset += 100) {
            const page = await client.listTransfers(offset);
            const c = original.correlation;
            if (
              page.source !== "provider" ||
              page.provider !== "ASAAS" ||
              page.siteId !== c.siteId ||
              page.accountBindingId !== c.accountId ||
              page.accountReference !== c.accountReference ||
              page.environment !== c.environment
            )
              unavailable();
            if (
              page.offset !== offset ||
              (total !== null && page.totalCount !== total)
            )
              unavailable();
            total = page.totalCount;
            for (const transfer of page.transfers) {
              if (seen.has(transfer.id)) unavailable();
              seen.add(transfer.id);
              if (
                transfer.externalReference !== original.correlation.operationId
              )
                continue;
              if (found) unavailable();
              found = {
                source: page.source,
                provider: page.provider,
                siteId: page.siteId,
                accountBindingId: page.accountBindingId,
                accountReference: page.accountReference,
                environment: page.environment,
                observedAt: page.observedAt,
                transfer,
              };
            }
            if (!page.hasMore) {
              if (!found) return { outcome: "NOT_FOUND" };
              return {
                outcome: "FOUND",
                observation: await observe(original, fence, found),
              };
            }
            if (page.transfers.length !== 100) unavailable();
          }
          return { outcome: "UNRESOLVED" };
        }
        return {
          outcome: "FOUND",
          observation: await observe(original, fence, found),
        };
      } catch (error) {
        logWithdrawalFailure(error);
        return { outcome: "UNRESOLVED" };
      }
    },
  };
}
