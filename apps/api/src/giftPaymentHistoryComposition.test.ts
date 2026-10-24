import { runInNewContext } from "node:vm";
import type { BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiOptions, createApp } from "./app";
import {
  type AuthFactoryOptions,
  createAuth,
  createSessionReadAuth,
} from "./auth";
import type { AuthInstance } from "./authHttp";
import {
  createGiftPaymentHistory,
  type GiftPaymentHistoryRepository,
} from "./giftPaymentHistory";
import {
  createGiftPaymentHistoryApplication,
  createGiftPaymentHistoryComposition,
  type GiftPaymentHistoryCompositionOptions,
} from "./giftPaymentHistoryComposition";
import type { createGiftPaymentHistoryRepository } from "./giftPaymentHistoryRepository";

const origin = "https://admin.example.test";
const instant = new Date("2026-10-13T14:00:00Z");
const configuration = {
  mode: "sandbox" as const,
  applicationEnvironment: "test" as const,
  policy: "SITE_HISTORY" as const,
};
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function deferred<T>(cleanup: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(() => resolve(cleanup));
  return { promise, resolve, reject };
}
async function flush() {
  for (let count = 0; count < 20; count++) await Promise.resolve();
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}
async function fixture() {
  const db = {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
  };
  const authentication: AuthFactoryOptions = {
    db: db as never,
    secret: "fictional-composition-secret-32-characters",
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  };
  const standardAuth = createAuth(authentication);
  const genuineReadAuth = createSessionReadAuth(authentication);
  const mediaAuth = createSessionReadAuth(authentication);
  for (const auth of [standardAuth, genuineReadAuth, mediaAuth]) {
    const context = await auth.$context;
    await context.checkSchema?.();
  }
  const nativeContext = await genuineReadAuth.$context;
  const schema = deferred<undefined>(undefined);
  const checkSchema = vi.fn(() => schema.promise);
  const contextValue = { ...nativeContext, checkSchema };
  const context = deferred(contextValue);
  // These explicitly synthetic timing ports retain the genuine SDK options.
  const readAuth = {
    ...genuineReadAuth,
    $context: context.promise,
  } as AuthInstance;
  const repository = {
    database: authentication.db,
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policy: "SITE_HISTORY" as const,
    readPurchasePage: vi.fn<GiftPaymentHistoryRepository["readPurchasePage"]>(),
    readPurchaseDetailPage:
      vi.fn<GiftPaymentHistoryRepository["readPurchaseDetailPage"]>(),
    close: vi.fn(async () => {}),
  };
  const createReadAuth = vi.fn<typeof createSessionReadAuth>(() => readAuth);
  const createRepository = vi.fn<typeof createGiftPaymentHistoryRepository>(
    () => repository,
  );
  const createService = vi.fn(createGiftPaymentHistory);
  const options: GiftPaymentHistoryCompositionOptions = {
    ...authentication,
    standardAuth,
    mediaAuth,
    now: () => new Date(instant),
    createReadAuth,
    createRepository,
    createService,
  };
  const appOptions: Omit<ApiOptions, "giftPaymentHistory"> = {
    auth: standardAuth,
    db: authentication.db,
    adminOrigin: origin,
    giftMediaAuth: mediaAuth,
    guestFingerprintSecret: "fictional-guest-secret-32-characters",
    guestTrustProxyHeaders: false,
    now: options.now,
  };
  const ready = () => {
    context.resolve(contextValue);
    schema.resolve(undefined);
  };
  return {
    db,
    authentication,
    standardAuth,
    genuineReadAuth,
    mediaAuth,
    context,
    contextValue,
    schema,
    checkSchema,
    readAuth,
    repository,
    options,
    appOptions,
    createReadAuth,
    createRepository,
    createService,
    ready,
  };
}

describe("private purchase history composition", () => {
  it("preserves the actual SDK composition with the exact development localhost trust list", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "development");
    const v = await fixture();
    const composition = await createGiftPaymentHistoryComposition(
      configuration,
      {
        ...v.options,
        createReadAuth: undefined,
        createRepository: undefined,
        createService: undefined,
      },
    );
    expect(composition.ports.giftPaymentHistory?.available).toBe(true);
    await composition.close();
    for (const method of Object.values(v.db))
      expect(method).not.toHaveBeenCalled();
  });
  it("returns frozen disabled ports before any private getter or factory", async () => {
    const get = vi.fn(() => {
      throw new Error("private option was accessed");
    });
    const options = new Proxy({} as GiftPaymentHistoryCompositionOptions, {
      get,
    });
    const composition = await createGiftPaymentHistoryComposition(
      { ...configuration, mode: "disabled" },
      options,
    );
    expect(composition.ports).toEqual({});
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.ports)).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(composition.close()).toBe(composition.close());
    await composition.close();
  });
  it.each([
    { mode: "browser-selected" },
    { applicationEnvironment: "staging" },
    { policy: "READY" },
  ])(
    "rejects unsupported passed configuration %j without private work",
    async (fault) => {
      const get = vi.fn(() => {
        throw new Error("private option was accessed");
      });
      await expect(
        createGiftPaymentHistoryComposition(
          { ...configuration, ...fault } as never,
          new Proxy({} as GiftPaymentHistoryCompositionOptions, { get }),
        ),
      ).rejects.toThrow("Purchase history unavailable");
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("uses the actual installed private SDK and accepted default constructors", async () => {
    const v = await fixture();
    const composition = await createGiftPaymentHistoryComposition(
      configuration,
      {
        ...v.options,
        createReadAuth: undefined,
        createRepository: undefined,
        createService: undefined,
      },
    );
    expect(composition.ports.giftPaymentHistory?.available).toBe(true);
    for (const method of Object.values(v.db))
      expect(method).not.toHaveBeenCalled();
    await composition.close();
    expect(
      (v.standardAuth.options.session as BetterAuthOptions["session"])
        ?.deferSessionRefresh,
    ).not.toBe(true);
    expect(
      (v.mediaAuth.options.session as BetterAuthOptions["session"])
        ?.deferSessionRefresh,
    ).toBe(true);
  });
  it("holds construction until context and independently started schema work settle", async () => {
    const v = await fixture();
    const task = createGiftPaymentHistoryComposition(configuration, v.options);
    const settled = observe(task);
    await flush();
    expect(settled()).toBe(false);
    expect(v.createRepository).not.toHaveBeenCalled();
    v.context.resolve(v.contextValue);
    await flush();
    expect(v.checkSchema).toHaveBeenCalledTimes(1);
    expect(settled()).toBe(false);
    expect(v.createRepository).not.toHaveBeenCalled();
    v.schema.resolve(undefined);
    const composition = await task;
    expect(composition.ports.giftPaymentHistory?.available).toBe(true);
    expect(v.createRepository).toHaveBeenCalledTimes(1);
    expect(v.createService.mock.calls[0]?.[0]?.authentication).toEqual({
      auth: v.readAuth,
      db: v.authentication.db,
    });
    await composition.close();
  });
  it.each(["context", "schema"] as const)(
    "sanitizes %s rejection after actual initialization settlement",
    async (phase) => {
      const v = await fixture();
      const task = createGiftPaymentHistoryComposition(
        configuration,
        v.options,
      );
      const settled = observe(task);
      await flush();
      expect(settled()).toBe(false);
      if (phase === "context")
        v.context.reject(new Error(v.authentication.secret));
      else {
        v.context.resolve(v.contextValue);
        await flush();
        expect(v.checkSchema).toHaveBeenCalledTimes(1);
        v.schema.reject(new Error(v.authentication.secret));
      }
      await expect(task).rejects.toThrow(/^Purchase history unavailable$/);
      expect(v.createRepository).not.toHaveBeenCalled();
    },
  );
  it.each(["throw", "mismatch"] as const)(
    "observes context before a later options %s and retains schema settlement",
    async (fault) => {
      const v = await fixture();
      let observed = false;
      const then = v.context.promise.then.bind(v.context.promise);
      vi.spyOn(v.context.promise, "then").mockImplementation((yes, no) => {
        observed = true;
        return then(yes, no);
      });
      Object.defineProperty(v.readAuth, "options", {
        get() {
          expect(observed).toBe(true);
          if (fault === "throw") throw new Error("private-validation-cause");
          return { ...v.genuineReadAuth.options, secret: "wrong-secret" };
        },
      });
      const task = createGiftPaymentHistoryComposition(
        configuration,
        v.options,
      );
      const settled = observe(task);
      await flush();
      expect(observed).toBe(true);
      expect(settled()).toBe(false);
      v.context.resolve(v.contextValue);
      await flush();
      expect(v.checkSchema).toHaveBeenCalledTimes(1);
      expect(settled()).toBe(false);
      v.schema.resolve(undefined);
      await expect(task).rejects.toThrow(/^Purchase history unavailable$/);
      expect(v.createRepository).not.toHaveBeenCalled();
    },
  );
  it("accepts genuine context/schema promises from another realm", async () => {
    const v = await fixture();
    const foreign = runInNewContext(`(() => {
      let resolve; const promise = new Promise(yes => { resolve = yes });
      return { promise, resolve };
    })()`) as {
      promise: Promise<typeof v.contextValue>;
      resolve(value: unknown): void;
    };
    releases.push(() => foreign.resolve(v.contextValue));
    v.readAuth.$context = foreign.promise;
    const foreignSchema = runInNewContext(
      "Promise.resolve()",
    ) as Promise<undefined>;
    v.checkSchema.mockReturnValue(foreignSchema);
    const task = createGiftPaymentHistoryComposition(configuration, v.options);
    const settled = observe(task);
    await flush();
    expect(settled()).toBe(false);
    foreign.resolve(v.contextValue);
    const composition = await task;
    expect(v.checkSchema).toHaveBeenCalledTimes(1);
    await composition.close();
  });
  it("accepts the installed check's cached clean undefined return", async () => {
    const v = await fixture();
    v.contextValue.checkSchema = vi.fn(() => undefined) as never;
    v.ready();
    const composition = await createGiftPaymentHistoryComposition(
      configuration,
      v.options,
    );
    expect(composition.ports.giftPaymentHistory?.available).toBe(true);
    await composition.close();
  });
  it.each([
    "ordinary",
    "media",
    "refresh",
    "origin",
    "secret",
    "baseURL",
  ] as const)(
    "rejects incompatible %s auth without constructing a repository",
    async (fault) => {
      const v = await fixture();
      if (fault === "ordinary")
        v.createReadAuth.mockReturnValue(v.standardAuth);
      if (fault === "media") v.createReadAuth.mockReturnValue(v.mediaAuth);
      if (fault === "refresh")
        (v.readAuth.options.session as BetterAuthOptions["session"]) = {
          deferSessionRefresh: false,
        };
      if (fault === "origin")
        v.readAuth.options.trustedOrigins = [origin, "https://other.test"];
      if (fault === "secret") v.readAuth.options.secret = "wrong-secret";
      if (fault === "baseURL")
        v.readAuth.options.baseURL = "https://other.test";
      v.ready();
      await expect(
        createGiftPaymentHistoryComposition(configuration, v.options),
      ).rejects.toThrow("Purchase history unavailable");
      expect(v.createRepository).not.toHaveBeenCalled();
    },
  );
  it("captures configuration, auth inputs and one bound clock before an await", async () => {
    const v = await fixture();
    const config = { ...configuration };
    const task = createGiftPaymentHistoryComposition(config, v.options);
    observe(task);
    config.mode = "live" as never;
    config.applicationEnvironment = "production" as never;
    v.options.db = {} as never;
    v.options.adminOrigin = "https://other.test";
    v.options.now = () => new Date(0);
    v.ready();
    const composition = await task;
    expect(v.createRepository).toHaveBeenCalledTimes(1);
    const [database, captured] = v.createRepository.mock
      .calls[0] as unknown as [
      unknown,
      {
        mode: string;
        applicationEnvironment: string;
        policy: string;
        now(): Date;
      },
    ];
    expect(database).toBe(v.authentication.db);
    expect(captured).toMatchObject(configuration);
    expect(captured.now()).toEqual(instant);
    expect(v.createReadAuth.mock.calls[0]?.[0]).toEqual(v.authentication);
    await composition.close();
  });
  it.each([
    "database",
    "mode",
    "environment",
    "policy",
    "unavailable",
    "throw",
  ] as const)(
    "drains the acquired repository before rejecting service %s",
    async (fault) => {
      const v = await fixture();
      const cleanup = deferred<undefined>(undefined);
      v.repository.close.mockImplementation(() => cleanup.promise);
      if (fault === "database") v.repository.database = {} as never;
      if (fault === "mode") v.repository.mode = "live" as never;
      if (fault === "environment")
        v.repository.applicationEnvironment = "production" as never;
      if (fault === "policy") v.repository.policy = "READY" as never;
      if (fault === "unavailable")
        v.createService.mockReturnValue(createGiftPaymentHistory());
      if (fault === "throw")
        v.createService.mockImplementation(() => {
          throw new Error("private-service-failure");
        });
      v.ready();
      const task = createGiftPaymentHistoryComposition(
        configuration,
        v.options,
      );
      const settled = observe(task);
      await flush();
      expect(v.repository.close).toHaveBeenCalledTimes(1);
      expect(settled()).toBe(false);
      cleanup.resolve(undefined);
      await expect(task).rejects.toThrow(/^Purchase history unavailable$/);
      expect(v.db.close).not.toHaveBeenCalled();
    },
  );
  it("memoizes the captured accepted service drain before reentrant callbacks", async () => {
    const v = await fixture();
    const cleanup = deferred<undefined>(undefined);
    v.ready();
    const composition = await createGiftPaymentHistoryComposition(
      configuration,
      v.options,
    );
    v.repository.close.mockImplementation(() => {
      expect(composition.close()).toBe(first);
      return cleanup.promise;
    });
    const first = composition.close();
    expect(composition.close()).toBe(first);
    await flush();
    expect(v.repository.close).toHaveBeenCalledTimes(1);
    expect(observe(first)()).toBe(false);
    cleanup.resolve(undefined);
    await first;
    expect(v.db.close).not.toHaveBeenCalled();
  });
  it("captures service ownership instead of bypassing it with a repository close", async () => {
    const v = await fixture();
    const gate = deferred<undefined>(undefined);
    let actualClose!: () => Promise<void>;
    const originalClose = vi.fn(async () => {
      await gate.promise;
      await actualClose();
    });
    let service!: ReturnType<typeof createGiftPaymentHistory>;
    v.createService.mockImplementation((options) => {
      const accepted = createGiftPaymentHistory(options);
      actualClose = accepted.close;
      service = { ...accepted, close: originalClose };
      return service;
    });
    v.ready();
    const composition = await createGiftPaymentHistoryComposition(
      configuration,
      v.options,
    );
    service.close = vi.fn(async () => {});
    const close = composition.close();
    const settled = observe(close);
    await flush();
    expect(originalClose).toHaveBeenCalledTimes(1);
    expect(service.close).not.toHaveBeenCalled();
    expect(v.repository.close).not.toHaveBeenCalled();
    expect(settled()).toBe(false);
    gate.resolve(undefined);
    await close;
    expect(v.repository.close).toHaveBeenCalledTimes(1);
    expect(v.db.close).not.toHaveBeenCalled();
  });
  it.each(["throw", "reject", "pending"] as const)(
    "does not certify completion when repository cleanup is %s",
    async (fault) => {
      const v = await fixture();
      v.createService.mockReturnValue(createGiftPaymentHistory());
      const cleanup = deferred<undefined>(undefined);
      v.repository.close.mockImplementation(() => {
        if (fault === "throw") throw new Error("private-cleanup-cause");
        return cleanup.promise;
      });
      v.ready();
      const task = createGiftPaymentHistoryComposition(
        configuration,
        v.options,
      );
      const settled = observe(task);
      await flush();
      expect(v.repository.close).toHaveBeenCalledTimes(1);
      if (fault === "reject")
        cleanup.reject(new Error("private-cleanup-cause"));
      await flush();
      expect(v.repository.close).toHaveBeenCalledTimes(1);
      expect(settled()).toBe(false);
      expect(v.db.close).not.toHaveBeenCalled();
      if (fault === "pending") {
        cleanup.resolve(undefined);
        await expect(task).rejects.toThrow("Purchase history unavailable");
      }
    },
  );
});

describe("real application construction with private history", () => {
  it("defaults to real createApp and retains health/history-only close without pool ownership", async () => {
    const v = await fixture();
    v.ready();
    const app = await createGiftPaymentHistoryApplication(
      configuration,
      v.options,
      v.appOptions,
    );
    expect((await app.request("/v1/health")).status).toBe(200);
    expect(
      (
        await app.request("/v1/sites/site-one/finance/purchases", {
          headers: { origin },
        })
      ).status,
    ).toBe(503);
    const close = app.close();
    expect(app.close()).toBe(close);
    await close;
    expect(v.repository.close).toHaveBeenCalledTimes(1);
    expect((await app.request("/v1/health")).status).toBe(200);
    expect(v.db.close).not.toHaveBeenCalled();
  });
  it("preserves captured ordinary/media/guest options and injects only history", async () => {
    const v = await fixture();
    const construct = vi.fn<typeof createApp>(createApp);
    const before = { ...v.appOptions };
    const task = createGiftPaymentHistoryApplication(
      configuration,
      v.options,
      v.appOptions,
      construct,
    );
    v.appOptions.guestTrustProxyHeaders = true;
    v.ready();
    const app = await task;
    const supplied = construct.mock.calls[0]?.[0];
    expect(supplied).toEqual({
      ...before,
      giftPaymentHistory: expect.objectContaining({ available: true }),
    });
    expect(supplied?.auth).toBe(v.standardAuth);
    expect(supplied?.giftMediaAuth).toBe(v.mediaAuth);
    await app.close();
  });
  it("does ordinary app construction in disabled mode without private history getters", async () => {
    const get = vi.fn(() => {
      throw new Error("private-history-input");
    });
    const options = new Proxy({} as GiftPaymentHistoryCompositionOptions, {
      get,
    });
    const app = await createGiftPaymentHistoryApplication(
      { ...configuration, mode: "disabled" },
      options,
      undefined,
    );
    expect((await app.request("/v1/health")).status).toBe(200);
    expect(
      (await app.request("/v1/sites/site-one/finance/purchases")).status,
    ).toBe(503);
    expect(get).not.toHaveBeenCalled();
    await app.close();
  });
  it("disabled construction cannot inherit a caller-supplied history singleton", async () => {
    const v = await fixture();
    v.ready();
    const existing = await createGiftPaymentHistoryComposition(
      configuration,
      v.options,
    );
    const construct = vi.fn<typeof createApp>(createApp);
    const get = vi.fn(() => {
      throw new Error("private-history-input");
    });
    try {
      const app = await createGiftPaymentHistoryApplication(
        { ...configuration, mode: "disabled" },
        new Proxy({} as GiftPaymentHistoryCompositionOptions, { get }),
        { ...v.appOptions, ...existing.ports } as never,
        construct,
      );
      expect(existing.ports.giftPaymentHistory?.available).toBe(true);
      expect(construct.mock.calls[0]?.[0]?.giftPaymentHistory).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
      await app.close();
      expect(v.repository.close).not.toHaveBeenCalled();
    } finally {
      await existing.close();
    }
  });
  it.each(["database", "auth", "origin", "media"] as const)(
    "rejects application %s mismatch and drains history before returning",
    async (fault) => {
      const v = await fixture();
      if (fault === "database") v.appOptions.db = {} as never;
      if (fault === "auth") v.appOptions.auth = v.mediaAuth;
      if (fault === "origin") v.appOptions.adminOrigin = "https://other.test";
      if (fault === "media") v.appOptions.giftMediaAuth = v.standardAuth;
      const construct = vi.fn<typeof createApp>(createApp);
      v.ready();
      await expect(
        createGiftPaymentHistoryApplication(
          configuration,
          v.options,
          v.appOptions,
          construct,
        ),
      ).rejects.toThrow("Purchase history unavailable");
      expect(construct).not.toHaveBeenCalled();
      expect(v.repository.close).toHaveBeenCalledTimes(1);
    },
  );
  it("awaits acquired history drainage after actual application constructor failure", async () => {
    const v = await fixture();
    const cleanup = deferred<undefined>(undefined);
    v.repository.close.mockImplementation(() => cleanup.promise);
    const construct = vi.fn<typeof createApp>(() => {
      throw new Error("private-application-cause");
    });
    v.ready();
    const task = createGiftPaymentHistoryApplication(
      configuration,
      v.options,
      v.appOptions,
      construct,
    );
    const settled = observe(task);
    await flush();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(v.repository.close).toHaveBeenCalledTimes(1);
    expect(settled()).toBe(false);
    cleanup.resolve(undefined);
    await expect(task).rejects.toThrow(/^Purchase history unavailable$/);
    expect(v.db.close).not.toHaveBeenCalled();
  });
  it("captures and memoizes the application's actual close before reentrant callbacks", async () => {
    const v = await fixture();
    const gate = deferred<undefined>(undefined);
    let reentered!: Promise<void>;
    let actualClose!: () => Promise<void>;
    let returned!: ReturnType<typeof createApp>;
    const close = vi.fn(async () => {
      reentered = returned.close();
      await actualClose();
      await gate.promise;
    });
    const construct = vi.fn<typeof createApp>((options) => {
      const app = createApp(options);
      actualClose = app.close.bind(app);
      app.close = close;
      return app;
    });
    v.ready();
    returned = await createGiftPaymentHistoryApplication(
      configuration,
      v.options,
      v.appOptions,
      construct,
    );
    const first = returned.close();
    const settled = observe(first);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(reentered).toBe(first);
    expect(returned.close()).toBe(first);
    expect(settled()).toBe(false);
    gate.resolve(undefined);
    await first;
    expect(v.db.close).not.toHaveBeenCalled();
  });
});
