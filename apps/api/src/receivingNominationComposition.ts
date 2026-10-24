import type { BetterAuthOptions } from "better-auth";
import { hasTrustedAdminOrigins, trustedAdminOrigin } from "./adminOrigin";
import type { ApiOptions } from "./app";
import { type AuthFactoryOptions, createSessionReadAuth } from "./auth";
import { type AuthInstance, readAdministrativeSession } from "./authHttp";
import {
  createFinancialReauthentication,
  type FinancialReauthenticationOptions,
} from "./financialReauthentication";
import type { LiveSitePolicy } from "./liveSitePolicy";
import {
  createReceivingNominationService,
  type ReceivingNominationConfiguration,
  type ReceivingNominationOptions,
  ReceivingNominationServiceError,
  readReceivingNominationConfiguration,
} from "./receivingNomination";
import { createReceivingNominationContext } from "./receivingNominationContext";

export interface ReceivingNominationCompositionOptions extends LiveSitePolicy {
  standardAuth: AuthInstance;
  authentication: AuthFactoryOptions;
  configuration: ReceivingNominationConfiguration;
  nomination: Pick<
    ReceivingNominationOptions,
    "repository" | "loadSite" | "generateId" | "admission"
  >;
  reauthentication: Omit<FinancialReauthenticationOptions, "now">;
  now(): Date;
}
export type ReceivingNominationCompositionPorts = Required<
  Pick<
    ApiOptions,
    | "financialReauthentication"
    | "receivingNomination"
    | "receivingNominationContext"
    | "readAdministrativeSession"
    | "now"
  >
>;

function unavailable(): never {
  throw new ReceivingNominationServiceError(
    503,
    "RECEIVING_NOMINATION_UNAVAILABLE",
  );
}

// Source-only composition: callers must explicitly provide every authority port.
// The isolated auth handler is private and is never returned or mounted.
export function createReceivingNominationComposition(
  options: ReceivingNominationCompositionOptions,
): ReceivingNominationCompositionPorts {
  try {
    const configuration = readReceivingNominationConfiguration(
      options.configuration,
    );
    const authentication = { ...options.authentication };
    const standardAuth = options.standardAuth;
    const suppliedClock = options.now;
    const sessionOptions: BetterAuthOptions["session"] =
      standardAuth?.options.session;
    if (
      typeof suppliedClock !== "function" ||
      !standardAuth ||
      sessionOptions?.deferSessionRefresh === true ||
      standardAuth.options.secret !== authentication.secret ||
      standardAuth.options.baseURL !== authentication.baseURL ||
      !hasTrustedAdminOrigins(
        standardAuth.options.trustedOrigins,
        authentication.adminOrigin,
      )
    )
      return unavailable();
    const now = suppliedClock.bind(options);
    const repository = options.nomination.repository;
    const suppliedSiteReader = options.nomination.loadSite;
    const suppliedIdGenerator = options.nomination.generateId;
    let admission: ReceivingNominationOptions["admission"];
    try {
      const descriptor = Object.getOwnPropertyDescriptor(
        options.nomination,
        "admission",
      );
      if (descriptor && "value" in descriptor) admission = descriptor.value;
    } catch {
      // Optional authority is absent when its own descriptor cannot be captured.
    }
    if (
      typeof suppliedSiteReader !== "function" ||
      typeof suppliedIdGenerator !== "function"
    )
      return unavailable();
    const loadSite = suppliedSiteReader.bind(options.nomination);
    const generateId = suppliedIdGenerator.bind(options.nomination);
    const proofOptions = { ...options.reauthentication, now };
    const financialReauthentication =
      createFinancialReauthentication(proofOptions);
    const liveSitePolicy =
      options.liveDemoSiteId === undefined
        ? {}
        : { liveDemoSiteId: options.liveDemoSiteId };
    const receivingNomination = createReceivingNominationService({
      ...liveSitePolicy,
      mode: configuration.mode,
      applicationEnvironment: configuration.applicationEnvironment,
      policyVersion: configuration.policyVersion,
      maxAuthAgeMs: proofOptions.maxAgeMs,
      now,
      loadSite,
      generateId,
      repository,
      admission,
    });
    const receivingNominationContext = createReceivingNominationContext({
      ...liveSitePolicy,
      configuration,
      repository,
      loadSite,
      now,
    });
    const readAuth = createSessionReadAuth(authentication);
    return Object.freeze({
      financialReauthentication,
      receivingNomination,
      receivingNominationContext,
      now,
      async readAdministrativeSession(request, requestOptions) {
        // GET must use the same application scope/clock and only replace auth.
        // Legacy login, /me and POST retain the caller's standard auth instance.
        if (
          requestOptions.auth !== standardAuth ||
          requestOptions.db !== authentication.db ||
          requestOptions.now !== now ||
          !trustedAdminOrigin(
            request.headers.get("origin"),
            authentication.adminOrigin,
          )
        )
          return unavailable();
        return readAdministrativeSession(request, {
          auth: readAuth,
          db: authentication.db,
          now,
        });
      },
    });
  } catch {
    return unavailable();
  }
}
