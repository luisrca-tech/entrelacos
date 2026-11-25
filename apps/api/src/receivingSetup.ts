import {
  createReceivingSetupInputSchema,
  pagarmeRecipientStatuses,
  type ReceivingProviderRejection,
  type ReceivingSetupContext,
  type ReceivingSetupReconcileResult,
  receivingConsentCoversCreatedRecipient,
  receivingProviderRejectionSchema,
  receivingSetupContextSchema,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import type { FinancialActor } from "./financialAuthorization";
import {
  mapPagarmeRecipientStatus,
  type PagarmeRecipientKyc,
} from "./pagarmeRecipientClient";
import type { createReceivingAccountProvisioning } from "./receivingAccountProvisioning";
import {
  deriveReceivingNominationRequestId,
  type ReceivingNominationService,
} from "./receivingNomination";
import {
  type ReceivingSetupAccountRecord,
  ReceivingSetupError,
  type ReceivingSetupRepository,
} from "./receivingSetupRepository";

/**
 * Pagar.me definitively refused the recipient and the dispatch was released:
 * the holder may correct the data and submit again.
 */
export class ReceivingProviderRejectedError extends Error {
  readonly status = 422;
  readonly code = "RECEIVING_PROVIDER_REJECTED";
  constructor(readonly rejection: ReceivingProviderRejection) {
    super("Pagar.me rejected the recipient");
    this.name = "ReceivingProviderRejectedError";
  }
}
export interface ReceivingRecipientObservation {
  readonly recipientId: string;
  /** Raw Pagar.me status; unknown values stay unverified. */
  readonly status: string;
  /** Pagar.me `kyc_details`; absent when the observation did not read it. */
  readonly kyc?: PagarmeRecipientKyc;
  readonly observedAt: string;
}
export interface ReceivingSetupServiceOptions {
  repository: Pick<
    ReceivingSetupRepository,
    | "mode"
    | "policyVersion"
    | "readHolder"
    | "requireHolder"
    | "readSessionAuthentication"
    | "readAccount"
    | "consent"
    | "designate"
    | "listHolderCandidates"
  >;
  nomination: Pick<ReceivingNominationService, "nominate">;
  provisioning: Pick<
    ReturnType<typeof createReceivingAccountProvisioning>,
    "begin"
  >;
  observe?: (
    siteId: string,
    account: ReceivingSetupAccountRecord,
  ) => Promise<ReceivingRecipientObservation>;
  /** Reference date for the holder's minimum age; defaults to now. */
  clock?: () => Date;
}
function recipientStatus(
  status: string,
): (typeof pagarmeRecipientStatuses)[number] | null {
  return (pagarmeRecipientStatuses as readonly string[]).includes(status)
    ? (status as (typeof pagarmeRecipientStatuses)[number])
    : null;
}
export function createReceivingSetupService(
  options: ReceivingSetupServiceOptions,
) {
  const repository = options.repository;
  // The marketplace's own identity check (Pagar.me runs none on a
  // pass-through account): CPF check digits, 18 or older on the reference
  // date, and the bank account under the same CPF (no other document field).
  const inputSchema = createReceivingSetupInputSchema(
    options.clock ?? (() => new Date()),
  );
  return Object.freeze({
    async read(
      actor: FinancialActor,
      platformRole?: "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT",
    ): Promise<ReceivingSetupContext> {
      const holder = await repository.readHolder(actor.siteId);
      const account = await repository.readAccount(actor.siteId);
      let providerStatus: ReceivingSetupContext["providerStatus"] = null;
      if (account?.state === "SUCCEEDED" && options.observe) {
        try {
          const observed = await options.observe(actor.siteId, account);
          if (observed.recipientId !== account.result?.recipientReference)
            throw new Error("Provider binding mismatch");
          const mapped = mapPagarmeRecipientStatus(observed.status);
          providerStatus = {
            recipientStatus: recipientStatus(observed.status),
            kycStatus: observed.kyc?.status ?? null,
            kycStatusReason: observed.kyc?.statusReason ?? null,
            accountState: mapped.providerAccountState,
            receivingEnabled: mapped.receivingCapability,
            observedAt: observed.observedAt,
          };
        } catch {
          /* A failed observation cannot turn a stored recipient into provider approval. */
        }
      }
      return receivingSetupContextSchema.parse({
        siteId: actor.siteId,
        mode: repository.mode,
        policyVersion: repository.policyVersion,
        holder: holder
          ? { userId: holder.holderUserId, name: holder.holderName }
          : null,
        isHolder: holder?.holderUserId === actor.userId,
        // A recipient created under the previous Pagar.me consent keeps
        // operating; before creation the current declaration is required.
        consentRecorded:
          !!holder?.consentId &&
          (holder.consentVersion === receivingSetupDisclosure.version ||
            (account?.state === "SUCCEEDED" &&
              receivingConsentCoversCreatedRecipient(holder.consentVersion))),
        // Whoever may designate sees the candidates: the owner always, a site
        // administrator (the route requires configureReceiving) only while no
        // holder exists.
        ...(platformRole === "OWNER" ||
        (platformRole === "SITE_ADMIN" && !holder)
          ? {
              holderCandidates: await repository.listHolderCandidates(
                actor.siteId,
              ),
            }
          : {}),
        disclosure: receivingSetupDisclosure,
        accountState: !account
          ? "NOT_CREATED"
          : account.state === "SUCCEEDED"
            ? "CREATED"
            : account.state === "REQUESTED"
              ? "PENDING"
              : "UNKNOWN",
        providerStatus,
      });
    },
    designate: repository.designate.bind(repository),
    async submit(
      rawInput: unknown,
      authorization: {
        actor: FinancialActor;
        access: SiteAccess;
      },
    ): Promise<{ state: "STORED" | "UNKNOWN" | "UNAVAILABLE" }> {
      const parsed = inputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new ReceivingSetupError(409, "RECEIVING_SETUP_INVALID_INPUT");
      const input = parsed.data;
      if (input.policyVersion !== repository.policyVersion)
        throw new ReceivingSetupError(409, "RECEIVING_SETUP_POLICY_CHANGED");
      const { actor, access } = authorization;
      await repository.requireHolder(actor);
      const recentAuth = await repository.readSessionAuthentication(actor);
      await repository.consent(actor, recentAuth, input.consentVersion);
      const previous = await repository.readAccount(actor.siteId);
      if (previous && previous.operatorUserId !== actor.userId)
        throw new ReceivingSetupError(403, "RECEIVING_HOLDER_REQUIRED");
      // The recipient already exists; never ask Pagar.me for another one.
      if (previous?.state === "SUCCEEDED") return { state: "STORED" };
      // An armed dispatch without a stored result is consulted on Pagar.me
      // by its code before anything is created again.
      const reconcile =
        previous?.state === "UNKNOWN" &&
        !!previous.record &&
        previous.record.sealedResult === null;
      if (previous && previous.state !== "REQUESTED" && !reconcile)
        return { state: "UNKNOWN" };
      const nomination =
        previous?.nomination ??
        (await options.nomination.nominate({
          actor,
          recentAuth,
          access,
          input: {
            requestId: deriveReceivingNominationRequestId({
              siteId: actor.siteId,
              operatorUserId: actor.userId,
              environment: repository.mode,
            }),
            policyVersion: repository.policyVersion,
            confirmSelfAsRecipient: true,
          },
        }));
      const owner = options.provisioning.begin({
        ...(reconcile && previous.record
          ? { action: "RECONCILE" as const, record: previous.record }
          : { action: "CREATE" as const }),
        nomination,
        input: {
          ...input.account,
          name: input.account.name.toLocaleUpperCase("pt-BR"),
        },
        authorization: { actor, recentAuth },
        confirmNativeCreation: true,
      });
      // The original owner continues durable settlement if its feedback is uncertain.
      void owner.completion.catch(() => {});
      const feedback = await owner.feedback;
      if (feedback.state === "REJECTED")
        throw new ReceivingProviderRejectedError(
          receivingProviderRejectionSchema.parse({
            message: feedback.rejection?.message ?? null,
            fields: feedback.rejection?.fields ?? [],
          }),
        );
      return {
        state:
          feedback.state === "STORED"
            ? "STORED"
            : feedback.state === "UNAVAILABLE"
              ? "UNAVAILABLE"
              : "UNKNOWN",
      };
    },
    /**
     * "Verificar situação": consults Pagar.me for an uncertain dispatch
     * without recipient input. It binds the recipient Pagar.me holds or
     * releases a dispatch proven absent so the holder can submit again; it
     * never creates a recipient.
     */
    async reconcile(
      actor: FinancialActor,
    ): Promise<ReceivingSetupReconcileResult> {
      await repository.requireHolder(actor);
      const recentAuth = await repository.readSessionAuthentication(actor);
      const previous = await repository.readAccount(actor.siteId);
      if (!previous)
        throw new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED");
      if (previous.operatorUserId !== actor.userId)
        throw new ReceivingSetupError(403, "RECEIVING_HOLDER_REQUIRED");
      if (previous.state === "SUCCEEDED") return { outcome: "STORED" };
      if (previous.state === "REQUESTED") return { outcome: "RELEASED" };
      if (previous.state === "CLAIMED")
        return { outcome: "UNKNOWN", reason: "DISPATCH_IN_PROGRESS" };
      // A sealed result is settled by a submit, not by a consultation.
      if (!previous.record || previous.record.sealedResult !== null)
        return { outcome: "UNKNOWN", reason: "UNAVAILABLE" };
      const owner = options.provisioning.begin({
        action: "VERIFY",
        record: previous.record,
        nomination: previous.nomination,
        authorization: { actor, recentAuth },
        confirmNativeCreation: true,
      });
      void owner.completion.catch(() => {});
      const feedback = await owner.feedback;
      if (feedback.state === "RELEASED") return { outcome: "RELEASED" };
      if (feedback.state === "STORED") return { outcome: "STORED" };
      return { outcome: "UNKNOWN", reason: feedback.reason ?? "UNAVAILABLE" };
    },
  });
}
export type ReceivingSetupService = ReturnType<
  typeof createReceivingSetupService
>;
