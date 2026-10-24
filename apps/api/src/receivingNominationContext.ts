import {
  type ReceivingNominationContext,
  receivingNominationContextSchema,
  receivingNominationInputSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";
import {
  deriveReceivingNominationRequestId,
  type ReceivingNominationConfiguration,
  type ReceivingNominationRepository,
  ReceivingNominationServiceError,
  readReceivingNominationConfiguration,
  readReceivingNominationSnapshot,
} from "./receivingNomination";

export interface ReceivingNominationContextOptions extends LiveSitePolicy {
  configuration: ReceivingNominationConfiguration;
  repository: Pick<ReceivingNominationRepository, "readNominationScope">;
  loadSite(siteId: string): Promise<{ siteId: string; isDemo: boolean } | null>;
  now(): Date;
}
export interface ReceivingNominationContextService {
  readonly configuration: Readonly<ReceivingNominationConfiguration>;
  readContext(input: {
    actor: unknown;
    access: unknown;
  }): Promise<ReceivingNominationContext>;
}
function unavailable(): never {
  throw new ReceivingNominationServiceError(
    503,
    "RECEIVING_NOMINATION_UNAVAILABLE",
  );
}

export function createReceivingNominationContext(
  options: ReceivingNominationContextOptions,
): ReceivingNominationContextService {
  try {
    const liveDemoSiteId = options.liveDemoSiteId;
    const configuration = readReceivingNominationConfiguration(
      options.configuration,
    );
    if (
      typeof options.repository?.readNominationScope !== "function" ||
      typeof options.loadSite !== "function" ||
      typeof options.now !== "function"
    )
      return unavailable();
    const readScope = options.repository.readNominationScope.bind(
      options.repository,
    );
    const loadSite = options.loadSite.bind(options);
    const now = options.now.bind(options);
    return {
      configuration,
      async readContext(input) {
        try {
          const raw = input.actor;
          const keys =
            raw && typeof raw === "object" ? Reflect.ownKeys(raw) : [];
          if (
            !raw ||
            typeof raw !== "object" ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype ||
            keys.length !== 3 ||
            keys.some(
              (key) => !["siteId", "userId", "sessionId"].includes(String(key)),
            )
          )
            throw new ReceivingNominationServiceError(403, "MEMBERSHIP_DENIED");
          const actor = raw as {
            siteId: unknown;
            userId: unknown;
            sessionId: unknown;
          };
          const site = siteIdSchema.safeParse(actor.siteId);
          const user = receivingNominationInputSchema.shape.requestId.safeParse(
            actor.userId,
          );
          const session =
            receivingNominationInputSchema.shape.requestId.safeParse(
              actor.sessionId,
            );
          const access = siteAccessSchema.safeParse(input.access);
          if (
            !site.success ||
            !user.success ||
            !session.success ||
            !access.success ||
            access.data.siteId !== site.data ||
            access.data.userId !== user.data ||
            access.data.membershipRole !== "SITE_ADMIN" ||
            access.data.membershipId === null ||
            !access.data.capabilities.configureReceiving
          )
            throw new ReceivingNominationServiceError(403, "MEMBERSHIP_DENIED");
          const scope = Object.freeze({
            siteId: site.data,
            operatorUserId: user.data,
            environment: configuration.mode,
          });
          let lastClock = -1;
          const clock = () => {
            const date = now();
            if (
              !(date instanceof Date) ||
              !Number.isSafeInteger(date.getTime()) ||
              date.getTime() < 0 ||
              date.getTime() < lastClock
            )
              return unavailable();
            lastClock = date.getTime();
            return lastClock;
          };
          clock();
          const storedSite = await loadSite(scope.siteId);
          clock();
          if (
            !storedSite ||
            Object.keys(storedSite).length !== 2 ||
            storedSite.siteId !== scope.siteId ||
            typeof storedSite.isDemo !== "boolean"
          )
            return unavailable();
          if (
            configuration.mode === "live" &&
            !allowsLiveSite({
              siteId: scope.siteId,
              isDemo: storedSite.isDemo,
              mode: configuration.mode,
              applicationEnvironment: configuration.applicationEnvironment,
              liveDemoSiteId: liveDemoSiteId,
            })
          )
            throw new ReceivingNominationServiceError(
              409,
              "PROVIDER_MODE_UNAVAILABLE",
            );
          const loaded = await readScope(scope);
          const observedAt = clock();
          if (loaded === null)
            return receivingNominationContextSchema.parse({
              siteId: scope.siteId,
              mode: configuration.mode,
              state: "AVAILABLE",
              requestId: deriveReceivingNominationRequestId(scope),
              policyVersion: configuration.policyVersion,
            });
          const snapshot = readReceivingNominationSnapshot(loaded);
          if (
            snapshot.siteId !== scope.siteId ||
            snapshot.operatorUserId !== scope.operatorUserId ||
            snapshot.environment !== configuration.mode ||
            Date.parse(snapshot.createdAt) > observedAt
          )
            return unavailable();
          return receivingNominationContextSchema.parse({
            siteId: scope.siteId,
            mode: configuration.mode,
            state: "PENDING",
            requestId: snapshot.requestId,
            policyVersion: snapshot.policyVersion,
            currentPolicyVersion: configuration.policyVersion,
            postAllowed: snapshot.policyVersion === configuration.policyVersion,
            nomination: {
              siteId: snapshot.siteId,
              requestId: snapshot.requestId,
              state: snapshot.state,
              createdAt: snapshot.createdAt,
              mode: snapshot.environment,
            },
          });
        } catch (error) {
          if (error instanceof ReceivingNominationServiceError) throw error;
          return unavailable();
        }
      },
    };
  } catch {
    return unavailable();
  }
}
