import {
  type ReceivingSetupContext,
  receivingSetupContextSchema,
  receivingSetupDisclosure,
  receivingSetupInputSchema,
  type SiteAccess,
} from "@entrelacos/contracts";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import type { createReceivingAccountProvisioning } from "./receivingAccountProvisioning";
import {
  deriveReceivingNominationRequestId,
  type ReceivingNominationService,
} from "./receivingNomination";
import {
  ReceivingPixDestinationError,
  type ReceivingPixDestinationLookup,
} from "./receivingPixDestination";
import type { createReceivingPixDestinationSetup } from "./receivingPixDestinationSetup";
import type { ReceivingSetupAsaasObservation } from "./receivingSetupAsaas";
import {
  type ReceivingSetupAccountRecord,
  ReceivingSetupError,
  type ReceivingSetupRepository,
} from "./receivingSetupRepository";

export interface ReceivingSetupServiceOptions {
  pixDestination?: ReceivingPixDestinationLookup;
  pixDestinationSetup?: Pick<
    ReturnType<typeof createReceivingPixDestinationSetup>,
    "read" | "confirm"
  > &
    Partial<
      Pick<
        ReturnType<typeof createReceivingPixDestinationSetup>,
        "readWithRecent"
      >
    >;
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
  ) => Promise<ReceivingSetupAsaasObservation>;
}
export function createReceivingSetupService(
  options: ReceivingSetupServiceOptions,
) {
  const repository = options.repository;
  return Object.freeze({
    async readPixDestination(actor: FinancialActor) {
      if (!options.pixDestinationSetup)
        throw new ReceivingPixDestinationError();
      return options.pixDestinationSetup.read(actor);
    },
    async readPixDestinationSnapshot(actor: FinancialActor) {
      if (!options.pixDestinationSetup)
        throw new ReceivingPixDestinationError();
      return options.pixDestinationSetup.readWithRecent
        ? options.pixDestinationSetup.readWithRecent(actor)
        : {
            destination: await options.pixDestinationSetup.read(actor),
            recentDestinations: [],
          };
    },
    async confirmPixDestination(
      actor: FinancialActor,
      input: {
        reviewToken: string;
        confirmRecipient: true;
        acceptThirdParty?: true;
      },
      recentAuth: RecentFinancialAuthenticationEvidence,
    ) {
      if (!options.pixDestinationSetup)
        throw new ReceivingPixDestinationError();
      return options.pixDestinationSetup.confirm(actor, input, recentAuth);
    },
    async lookupPixDestination(actor: FinancialActor, input: unknown) {
      if (!options.pixDestination) throw new ReceivingPixDestinationError();
      return options.pixDestination.lookup(actor, input);
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
          if (
            observed.siteId !== actor.siteId ||
            observed.accountBindingId !== account.accountId ||
            observed.environment !== repository.mode ||
            observed.accountReference !== account.result?.accountReference ||
            observed.recipientReference !== account.result?.recipientReference
          )
            throw new Error("Provider binding mismatch");
          const { id: _statusId, ...status } = observed.status;
          providerStatus = {
            ...status,
            commercialInfoExpired: observed.commercialInfoExpired,
            observedAt: observed.observedAt,
          };
        } catch {
          /* A failed observation cannot turn stored credentials into provider approval. */
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
        input: input.account,
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
