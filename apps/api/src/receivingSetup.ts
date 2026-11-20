import {
  pagarmeRecipientStatuses,
  type ReceivingKycLink,
  type ReceivingSetupContext,
  receivingKycLinkSchema,
  receivingSetupContextSchema,
  receivingSetupDisclosure,
  receivingSetupInputSchema,
  type SiteAccess,
} from "@entrelacos/contracts";
import type { FinancialActor } from "./financialAuthorization";
import { PagarmeRejectedError } from "./pagarmeHttpClient";
import {
  mapPagarmeRecipientStatus,
  type PagarmeRecipientClient,
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

export interface ReceivingRecipientObservation {
  readonly recipientId: string;
  /** Raw Pagar.me status; unknown values stay unverified. */
  readonly status: string;
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
  recipients?: Pick<PagarmeRecipientClient, "createKycLink">;
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
  return Object.freeze({
    /**
     * Issues a short-lived Pagar.me identity verification link. The link is
     * returned to the caller only: it is never stored or logged.
     */
    async createKycLink(
      actor: FinancialActor,
      platformRole: "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT",
    ): Promise<ReceivingKycLink> {
      const account = await repository.readAccount(actor.siteId);
      if (platformRole !== "OWNER" && account?.operatorUserId !== actor.userId)
        throw new ReceivingSetupError(403, "MEMBERSHIP_DENIED");
      if (account?.state !== "SUCCEEDED" || !account.result)
        throw new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED");
      if (!options.recipients)
        throw new ReceivingSetupError(503, "RECEIVING_SETUP_UNAVAILABLE");
      let link: unknown;
      try {
        link = await options.recipients.createKycLink(
          account.result.recipientReference,
        );
      } catch (error) {
        // Pagar.me refuses a link when no identity check is pending.
        if (error instanceof PagarmeRejectedError)
          throw new ReceivingSetupError(409, "RECEIVING_KYC_LINK_UNAVAILABLE");
        throw error;
      }
      return receivingKycLinkSchema.parse(link);
    },
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
        consentRecorded:
          !!holder?.consentId &&
          holder.consentVersion === receivingSetupDisclosure.version,
        ...(platformRole === "OWNER"
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
      const parsed = receivingSetupInputSchema.safeParse(rawInput);
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
      if (previous && previous.state !== "REQUESTED")
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
        action: "CREATE",
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
      return { state: feedback.state };
    },
  });
}
export type ReceivingSetupService = ReturnType<
  typeof createReceivingSetupService
>;
