import { isPromise } from "node:util/types";
import type { BetterAuthOptions } from "better-auth";
import { hasTrustedAdminOrigins } from "./adminOrigin";
import { type ApiOptions, createApp } from "./app";
import { type AuthFactoryOptions, createSessionReadAuth } from "./auth";
import type { AuthInstance } from "./authHttp";
import {
  createGiftPaymentHistory,
  GiftPaymentHistoryError,
  type GiftPaymentHistoryService,
} from "./giftPaymentHistory";
import { createGiftPaymentHistoryRepository } from "./giftPaymentHistoryRepository";

export interface GiftPaymentHistoryCompositionConfig {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  policy: "SITE_HISTORY";
}
export interface GiftPaymentHistoryCompositionOptions
  extends AuthFactoryOptions {
  standardAuth: AuthInstance;
  mediaAuth?: AuthInstance;
  now(): Date;
  createReadAuth?: typeof createSessionReadAuth;
  createRepository?: typeof createGiftPaymentHistoryRepository;
  createService?: typeof createGiftPaymentHistory;
}
export interface GiftPaymentHistoryComposition {
  readonly ports: Readonly<{ giftPaymentHistory?: GiftPaymentHistoryService }>;
  close(): Promise<void>;
}

function unavailable(): never {
  throw new GiftPaymentHistoryError();
}
function unsettled(): Promise<never> {
  return new Promise(() => {});
}

// An uncertain drain cannot certify that the caller may release shared dependencies.
function captureClose(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    let resolve!: () => void;
    closing = new Promise<void>((yes) => {
      resolve = yes;
    });
    try {
      const actual = close();
      if (isPromise(actual)) void actual.then(resolve, () => {});
    } catch {
      // Throwing disposal does not prove actual settlement.
    }
    return closing;
  };
}

function initializeReadAuth(auth: AuthInstance): Promise<boolean> {
  try {
    const actual = auth.$context;
    if (!isPromise(actual)) return unsettled();
    const initialization = actual.then(async (context) => {
      let schema: unknown;
      try {
        const check = context.checkSchema;
        if (typeof check !== "function") return await unsettled();
        schema = check.call(context);
      } catch {
        return await unsettled();
      }
      // The installed check returns undefined after its cached clean verdict.
      if (schema === undefined) return;
      if (!isPromise(schema)) return await unsettled();
      await schema;
    });
    return initialization.then(
      () => true,
      () => false,
    );
  } catch {
    return unsettled();
  }
}

function matchesAuth(auth: AuthInstance, configuration: AuthFactoryOptions) {
  const options = auth.options;
  return (
    options.secret === configuration.secret &&
    options.baseURL === configuration.baseURL &&
    hasTrustedAdminOrigins(options.trustedOrigins, configuration.adminOrigin)
  );
}

interface CompositionIdentity {
  db: AuthFactoryOptions["db"];
  adminOrigin: string;
  standardAuth: AuthInstance;
  mediaAuth?: AuthInstance;
}

async function compose(
  config: GiftPaymentHistoryCompositionConfig,
  options: GiftPaymentHistoryCompositionOptions,
): Promise<{
  composition: GiftPaymentHistoryComposition;
  identity?: CompositionIdentity;
}> {
  let acquired = false;
  let close: (() => Promise<void>) | undefined;
  try {
    const mode = config.mode;
    if (mode === "disabled") {
      return {
        composition: Object.freeze({
          ports: Object.freeze({}),
          close: captureClose(async () => {}),
        }),
      };
    }
    const applicationEnvironment = config.applicationEnvironment;
    const policy = config.policy;
    if (
      !["sandbox", "live"].includes(mode) ||
      !["test", "development", "production"].includes(applicationEnvironment) ||
      policy !== "SITE_HISTORY"
    )
      return unavailable();
    const authentication = Object.freeze({
      db: options.db,
      secret: options.secret,
      baseURL: options.baseURL,
      adminOrigin: options.adminOrigin,
    });
    const standardAuth = options.standardAuth;
    const mediaAuth = options.mediaAuth;
    const now = options.now.bind(options);
    const createReadAuth = options.createReadAuth ?? createSessionReadAuth;
    const createRepository =
      options.createRepository ?? createGiftPaymentHistoryRepository;
    const createService = options.createService ?? createGiftPaymentHistory;
    const readAuth = createReadAuth(authentication);
    // Register both SDK outcomes before any later validation can abandon initialization.
    const initialized = initializeReadAuth(readAuth);
    let compatible = false;
    try {
      compatible =
        readAuth !== standardAuth &&
        readAuth !== mediaAuth &&
        matchesAuth(readAuth, authentication) &&
        matchesAuth(standardAuth, authentication) &&
        (readAuth.options.session as BetterAuthOptions["session"])
          ?.deferSessionRefresh === true &&
        (standardAuth.options.session as BetterAuthOptions["session"])
          ?.deferSessionRefresh !== true &&
        (!mediaAuth || matchesAuth(mediaAuth, authentication));
    } catch {
      // The already registered initialization still owns actual SDK settlement.
    }
    const settled = await initialized;
    if (!compatible || !settled) return unavailable();
    const repository = createRepository(authentication.db, {
      mode,
      applicationEnvironment,
      policy,
      now,
    });
    acquired = true;
    close = captureClose(repository.close.bind(repository));
    const service = createService({
      mode,
      applicationEnvironment,
      policy,
      adminOrigin: authentication.adminOrigin,
      now,
      authentication: { auth: readAuth, db: authentication.db },
      repository,
    });
    if (!service.available) return unavailable();
    close = captureClose(service.close.bind(service));
    return {
      identity: {
        db: authentication.db,
        adminOrigin: authentication.adminOrigin,
        standardAuth,
        mediaAuth,
      },
      composition: Object.freeze({
        ports: Object.freeze({ giftPaymentHistory: service }),
        close,
      }),
    };
  } catch {
    if (acquired && !close) await unsettled();
    await close?.();
    return unavailable();
  }
}

export async function createGiftPaymentHistoryComposition(
  config: GiftPaymentHistoryCompositionConfig,
  options: GiftPaymentHistoryCompositionOptions,
): Promise<GiftPaymentHistoryComposition> {
  return (await compose(config, options)).composition;
}

export async function createGiftPaymentHistoryApplication(
  config: GiftPaymentHistoryCompositionConfig,
  options: GiftPaymentHistoryCompositionOptions,
  applicationOptions?: Omit<ApiOptions, "giftPaymentHistory">,
  createApplication: typeof createApp = createApp,
): Promise<ReturnType<typeof createApp>> {
  let composition: GiftPaymentHistoryComposition | undefined;
  try {
    const capturedOptions = applicationOptions
      ? { ...applicationOptions }
      : undefined;
    const built = await compose(config, options);
    composition = built.composition;
    const identity = built.identity;
    if (
      identity &&
      (!capturedOptions ||
        capturedOptions.db !== identity.db ||
        capturedOptions.auth !== identity.standardAuth ||
        capturedOptions.adminOrigin !== identity.adminOrigin ||
        capturedOptions.giftMediaAuth !== identity.mediaAuth)
    )
      return unavailable();
    const app = createApplication(
      capturedOptions
        ? {
            ...capturedOptions,
            giftPaymentHistory: composition.ports.giftPaymentHistory,
          }
        : undefined,
    );
    const close = app.close.bind(app);
    return Object.assign(app, { close: captureClose(close) });
  } catch {
    await composition?.close();
    return unavailable();
  }
}
