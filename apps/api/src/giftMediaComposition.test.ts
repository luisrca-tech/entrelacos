import { EventEmitter } from "node:events";
import type { createAdaptorServer } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import type { AuthHttpOptions } from "./authHttp";
import { createGiftMediaProcessing } from "./giftMedia";
import {
  createGiftMediaComposition,
  startGiftMediaRuntime,
} from "./giftMediaComposition";
import type { GiftMediaConfig } from "./giftMediaConfig";
import type {
  GiftMediaStorage,
  R2GiftMediaStorageOptions,
} from "./giftMediaStorage";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function configuration(): GiftMediaConfig {
  return {
    mode: "r2",
    accountId: "a".repeat(32),
    accessKeyId: "synthetic-key",
    secretAccessKey: "synthetic-secret",
    bucketName: "existing-development-bucket",
    publicOrigin: "https://images.example.test",
  };
}
function factories() {
  const storage: GiftMediaStorage = {
    storageNamespace: "r2:captured-bucket",
    getDerivativeUrl: vi.fn(),
    headDerivative: vi.fn(),
    readDerivative: vi.fn(),
    publishDerivative: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const processing = createGiftMediaProcessing();
  const readAuth = { $context: Promise.resolve({}) } as never;
  const decode = vi.fn() as never;
  const options = {
    createStorage: vi.fn((_config: R2GiftMediaStorageOptions) => storage),
    createProcessing: vi.fn(() => processing),
    createReadAuth: vi.fn(() => readAuth),
    decode,
  };
  return { options, storage, processing, readAuth, decode };
}
function runtimeFixture() {
  const server = new EventEmitter();
  const signals = new EventEmitter();
  let httpComplete!: (error?: Error) => void;
  const listen = vi.fn();
  const closeHttp = vi.fn((callback: (error?: Error) => void) => {
    httpComplete = callback;
    return server;
  });
  Object.assign(server, { listen, close: closeHttp });
  const createServer = vi.fn(
    (_options: Parameters<typeof createAdaptorServer>[0]) =>
      server as unknown as ReturnType<typeof createAdaptorServer>,
  );
  const media = {
    ports: {},
    close: vi.fn(async () => {}),
  };
  const fetch = vi.fn(async () => new Response("accepted"));
  const createFetch = vi.fn(() => fetch);
  const closeDatabase = vi.fn(async () => {});
  const auth = { $context: Promise.resolve({}) } as AuthHttpOptions["auth"];
  const initialize = vi.fn(async () => auth);
  const createMedia = vi.fn(async () => media);
  const onError = vi.fn();
  const options = {
    initialize,
    createMedia,
    createFetch,
    createServer,
    port: 8080,
    signals,
    closeDatabase,
    onError,
  };
  return {
    options,
    server,
    signals,
    listen,
    media,
    fetch,
    createFetch,
    closeDatabase,
    closeHttp,
    completeHttp: (error?: Error) => httpComplete(error),
  };
}

describe("captured gift media composition", () => {
  it("disabled returns before all private config and factory reads", async () => {
    const config = { mode: "disabled" };
    const options = {};
    for (const key of [
      "accountId",
      "accessKeyId",
      "secretAccessKey",
      "bucketName",
      "publicOrigin",
    ])
      Object.defineProperty(config, key, {
        get: () => {
          throw new Error("private configuration read");
        },
      });
    for (const key of [
      "createStorage",
      "createProcessing",
      "createReadAuth",
      "decode",
    ])
      Object.defineProperty(options, key, {
        get: () => {
          throw new Error("factory read");
        },
      });
    const media = await createGiftMediaComposition(
      config as GiftMediaConfig,
      options as never,
    );
    expect(media.ports).toEqual({});
    const closing = media.close();
    expect(media.close()).toBe(closing);
    await closing;
  });

  it("captures exactly one storage, processing, decoder and deferred read auth", async () => {
    const config = configuration();
    const fixture = factories();
    const media = await createGiftMediaComposition(config, fixture.options);
    expect(fixture.options.createStorage).toHaveBeenCalledExactlyOnceWith({
      accountId: "a".repeat(32),
      accessKeyId: "synthetic-key",
      secretAccessKey: "synthetic-secret",
      bucketName: "existing-development-bucket",
      publicOrigin: "https://images.example.test",
    });
    expect(fixture.options.createProcessing).toHaveBeenCalledOnce();
    expect(fixture.options.createReadAuth).toHaveBeenCalledOnce();
    expect(media.ports).toEqual({
      storage: fixture.storage,
      storageNamespace: fixture.storage.storageNamespace,
      processing: fixture.processing,
      decode: fixture.decode,
      giftMediaAuth: fixture.readAuth,
    });
    expect(Object.isFrozen(media.ports)).toBe(true);
    if (config.mode === "r2") config.bucketName = "changed-bucket";
    expect(fixture.options.createStorage.mock.calls[0][0].bucketName).toBe(
      "existing-development-bucket",
    );
    await media.close();
    expect(fixture.storage.close).toHaveBeenCalledOnce();
  });

  it("owns read auth context initialization before publishing ports", async () => {
    const fixture = factories();
    const context = deferred();
    fixture.options.createReadAuth.mockReturnValue({
      $context: context.promise,
    } as never);
    const construction = createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    let published = false;
    void construction.then(() => {
      published = true;
    });
    try {
      await flush();
      expect(published).toBe(false);
      expect(fixture.storage.close).not.toHaveBeenCalled();
    } finally {
      context.resolve();
      const media = await construction;
      await media.close();
    }
  });

  it("late read auth context rejection remains sanitized and drains acquired resources", async () => {
    const fixture = factories();
    const context = deferred();
    void context.promise.catch(() => {});
    fixture.options.createReadAuth.mockReturnValue({
      $context: context.promise,
    } as never);
    const construction = createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    const failure = expect(construction).rejects.toThrow(
      "Gift media composition unavailable",
    );
    await flush();
    context.reject(new Error("private auth initialization failure"));
    await failure;
    expect(fixture.storage.close).toHaveBeenCalledOnce();
  });

  it("retains the existing read auth schema check until actual settlement", async () => {
    const fixture = factories();
    const schema = deferred();
    const checkSchema = vi.fn(() => schema.promise);
    fixture.options.createReadAuth.mockReturnValue({
      $context: Promise.resolve({ checkSchema }),
    } as never);
    const construction = createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    let published = false;
    void construction.then(() => {
      published = true;
    });
    try {
      await flush();
      expect(published).toBe(false);
      expect(checkSchema).toHaveBeenCalledOnce();
    } finally {
      schema.resolve();
      await (await construction).close();
    }
  });

  it("awaits rejected native schema checks while preserving SDK validation policy", async () => {
    const fixture = factories();
    const schema = deferred();
    void schema.promise.catch(() => {});
    fixture.options.createReadAuth.mockReturnValue({
      $context: Promise.resolve({ checkSchema: () => schema.promise }),
    } as never);
    const construction = createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    let published = false;
    void construction.then(() => {
      published = true;
    });
    try {
      await flush();
      expect(published).toBe(false);
    } finally {
      schema.reject(new Error("native logged schema verdict"));
      await (await construction).close();
    }
  });

  for (const phase of ["createProcessing", "createReadAuth", "decode"] as const)
    it(`drains acquired resources when ${phase} construction fails`, async () => {
      const fixture = factories();
      const pending = deferred();
      const operation = fixture.processing.track(async () => pending.promise);
      const operationFailure = operation.catch(() => {});
      if (phase === "decode")
        Object.defineProperty(fixture.options, phase, {
          get: () => {
            throw new Error("private failure");
          },
        });
      else
        fixture.options[phase].mockImplementation(() => {
          throw new Error("private failure");
        });
      const construction = createGiftMediaComposition(
        configuration(),
        fixture.options,
      );
      const failure = expect(construction).rejects.toThrow(
        "Gift media composition unavailable",
      );
      await flush();
      if (phase !== "createProcessing")
        expect(fixture.storage.close).not.toHaveBeenCalled();
      pending.resolve();
      await operationFailure;
      if (phase === "createProcessing") await fixture.processing.close();
      await failure;
      expect(fixture.storage.close).toHaveBeenCalledOnce();
    });

  for (const stage of ["auth", "body", "native metadata", "SDK", "DB commit"])
    it(`close retains actual ${stage} work after cancellation`, async () => {
      const fixture = factories();
      const pending = deferred();
      const media = await createGiftMediaComposition(
        configuration(),
        fixture.options,
      );
      let signal!: AbortSignal;
      const operation = fixture.processing.track(async (ownedSignal) => {
        signal = ownedSignal;
        await pending.promise;
      });
      const failure = operation.catch(() => {});
      const closing = media.close();
      expect(media.close()).toBe(closing);
      expect(signal.aborted).toBe(true);
      await expect(fixture.processing.track(async () => {})).rejects.toThrow();
      await flush();
      expect(fixture.storage.close).not.toHaveBeenCalled();
      pending.resolve();
      await failure;
      await closing;
      expect(fixture.storage.close).toHaveBeenCalledOnce();
    });

  it("memoizes close before synchronous child reentry", async () => {
    const fixture = factories();
    let nested: Promise<void> | undefined;
    fixture.options.createProcessing.mockReturnValue({
      ...fixture.processing,
      close: () => {
        nested = media.close();
        return Promise.resolve();
      },
    });
    const media = await createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    const closing = media.close();
    expect(nested).toBe(closing);
    await closing;
  });

  it("a thrown processing drain cannot prove storage is safe to destroy", async () => {
    const fixture = factories();
    fixture.options.createProcessing.mockReturnValue({
      ...fixture.processing,
      close: () => {
        throw new Error("broken processing drain");
      },
    });
    const media = await createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    const closing = media.close();
    void closing.catch(() => {});
    await flush();
    expect(fixture.storage.close).not.toHaveBeenCalled();
    expect(media.close()).toBe(closing);
    await fixture.processing.close();
  });

  it("a rejected processing drain cannot prove storage is safe to destroy", async () => {
    const fixture = factories();
    fixture.options.createProcessing.mockReturnValue({
      ...fixture.processing,
      close: () => Promise.reject(new Error("unproved processing drain")),
    });
    const media = await createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    const closing = media.close();
    void closing.catch(() => {});
    await flush();
    expect(fixture.storage.close).not.toHaveBeenCalled();
    await fixture.processing.close();
  });

  it("awaits actual body cancellation before releasing storage", async () => {
    const fixture = factories();
    const cancellation = deferred();
    const body = new ReadableStream<Uint8Array>(
      {
        cancel: () => cancellation.promise,
      },
      { highWaterMark: 0 },
    );
    const media = await createGiftMediaComposition(
      configuration(),
      fixture.options,
    );
    const operation = fixture.processing.track(async (signal) => {
      const reader = body.getReader();
      let cancelled: Promise<void> | undefined;
      const cancel = () => {
        cancelled ??= reader.cancel();
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await reader.read();
      } finally {
        if (cancelled) await cancelled;
        reader.releaseLock();
        signal.removeEventListener("abort", cancel);
      }
    });
    const failure = operation.catch(() => {});
    const closing = media.close();
    await flush();
    expect(fixture.storage.close).not.toHaveBeenCalled();
    cancellation.resolve();
    await failure;
    await closing;
    expect(fixture.storage.close).toHaveBeenCalledOnce();
  });
});

describe("gift media runtime lifecycle with synthetic server", () => {
  it("awaits actual listening, gates entry immediately and closes DB only after media and HTTP", async () => {
    const fixture = runtimeFixture();
    const pipeline = deferred();
    const database = deferred();
    fixture.media.close.mockImplementation(() => pipeline.promise);
    fixture.closeDatabase.mockImplementation(() => database.promise);
    const runtime = startGiftMediaRuntime(fixture.options);
    let ready = false;
    void runtime.ready.then(() => {
      ready = true;
    });
    await flush();
    expect(fixture.listen).toHaveBeenCalledExactlyOnceWith(8080);
    expect(ready).toBe(false);
    const argumentsForServer = vi.mocked(fixture.options.createServer).mock
      .calls[0][0];
    const guardedFetch = argumentsForServer.fetch;
    const request = new Request("https://api.example.test/v1/health");
    expect(await guardedFetch(request, {} as never)).toBeInstanceOf(Response);
    fixture.server.emit("listening");
    await runtime.ready;
    expect(ready).toBe(true);
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    fixture.signals.emit("SIGINT");
    fixture.signals.emit("SIGTERM");
    expect(fixture.closeHttp).toHaveBeenCalledOnce();
    expect(fixture.media.close).toHaveBeenCalledOnce();
    const denied = (await guardedFetch(request, {} as never)) as Response;
    expect(denied.status).toBe(503);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    fixture.completeHttp();
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    pipeline.resolve();
    await flush();
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
    let stopped = false;
    void closing.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    database.resolve();
    await closing;
    expect(stopped).toBe(true);
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
    expect(fixture.server.listenerCount("error")).toBe(0);
  });

  it("also waits HTTP completion when media/storage have drained", async () => {
    const fixture = runtimeFixture();
    const runtime = startGiftMediaRuntime(fixture.options);
    await flush();
    fixture.server.emit("listening");
    await runtime.ready;
    const closing = runtime.close();
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    fixture.completeHttp();
    await closing;
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
  });

  for (const stage of ["initialize", "createMedia"] as const)
    it(`signal during ${stage} owns pending construction and prevents later dispatch`, async () => {
      const fixture = runtimeFixture();
      const pending = deferred();
      if (stage === "initialize")
        fixture.options.initialize.mockImplementation(async () => {
          await pending.promise;
          return { $context: Promise.resolve({}) } as AuthHttpOptions["auth"];
        });
      else
        fixture.options.createMedia.mockImplementation(async () => {
          await pending.promise;
          return fixture.media;
        });
      const runtime = startGiftMediaRuntime(fixture.options);
      const failure = expect(runtime.ready).rejects.toThrow(
        "Gift media runtime unavailable",
      );
      await flush();
      fixture.signals.emit("SIGTERM");
      const closing = runtime.close();
      await flush();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      expect(fixture.listen).not.toHaveBeenCalled();
      pending.resolve();
      await closing;
      await failure;
      expect(fixture.createFetch).not.toHaveBeenCalled();
      if (stage === "createMedia")
        expect(fixture.media.close).toHaveBeenCalledOnce();
      else expect(fixture.options.createMedia).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).toHaveBeenCalledOnce();
    });

  it("a signal retains normal auth initialization and prevents media/server construction", async () => {
    const fixture = runtimeFixture();
    const context = deferred();
    fixture.options.initialize.mockResolvedValue({
      $context: context.promise,
    } as unknown as AuthHttpOptions["auth"]);
    const runtime = startGiftMediaRuntime(fixture.options);
    const failure = runtime.ready.catch(() => {});
    await flush();
    const closing = runtime.close();
    try {
      await flush();
      expect(fixture.options.createMedia).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
    } finally {
      context.resolve();
      if (fixture.closeHttp.mock.calls.length) fixture.completeHttp();
      await closing;
      await failure;
    }
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
  });

  it("normal auth context rejection closes DB once without creating media or server", async () => {
    const fixture = runtimeFixture();
    const context = deferred();
    fixture.options.initialize.mockResolvedValue({
      $context: context.promise,
    } as unknown as AuthHttpOptions["auth"]);
    const runtime = startGiftMediaRuntime(fixture.options);
    const failure = expect(runtime.ready).rejects.toThrow(
      "Gift media runtime unavailable",
    );
    await flush();
    context.reject(new Error("private normal auth initialization"));
    await failure;
    expect(fixture.options.createMedia).not.toHaveBeenCalled();
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
    await runtime.close();
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
  });

  it("shutdown retains normal auth's already-started schema check before closing DB", async () => {
    const fixture = runtimeFixture();
    const schema = deferred();
    fixture.options.initialize.mockResolvedValue({
      $context: Promise.resolve({ checkSchema: () => schema.promise }),
    } as unknown as AuthHttpOptions["auth"]);
    const runtime = startGiftMediaRuntime(fixture.options);
    const failure = runtime.ready.catch(() => {});
    await flush();
    const closing = runtime.close();
    try {
      await flush();
      expect(fixture.options.createMedia).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
    } finally {
      schema.resolve();
      if (fixture.closeHttp.mock.calls.length) fixture.completeHttp();
      await closing;
      await failure;
    }
  });

  it("signal during listen cannot accept a late listening callback", async () => {
    const fixture = runtimeFixture();
    const runtime = startGiftMediaRuntime(fixture.options);
    const failure = expect(runtime.ready).rejects.toThrow(
      "Gift media runtime unavailable",
    );
    await flush();
    fixture.signals.emit("SIGINT");
    fixture.server.emit("listening");
    fixture.completeHttp();
    await runtime.close();
    await failure;
    expect(fixture.closeHttp).toHaveBeenCalledOnce();
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
  });

  for (const phase of [
    "initialize",
    "createMedia",
    "createFetch",
    "createServer",
    "listen",
  ] as const)
    it(`disposes every acquired resource after synchronous ${phase} failure`, async () => {
      const fixture = runtimeFixture();
      const method =
        phase === "listen" ? fixture.listen : fixture.options[phase];
      vi.mocked(method).mockImplementation(() => {
        throw new Error("private startup detail");
      });
      const runtime = startGiftMediaRuntime(fixture.options);
      const failure = expect(runtime.ready).rejects.toThrow(
        "Gift media runtime unavailable",
      );
      await flush();
      if (phase === "listen") fixture.completeHttp();
      await failure;
      expect(fixture.closeDatabase).toHaveBeenCalledOnce();
      if (!["initialize", "createMedia"].includes(phase))
        expect(fixture.media.close).toHaveBeenCalledOnce();
    });

  it("asynchronous listen error uses the same draining owner", async () => {
    const fixture = runtimeFixture();
    const pending = deferred();
    fixture.media.close.mockImplementation(() => pending.promise);
    const runtime = startGiftMediaRuntime(fixture.options);
    const failure = expect(runtime.ready).rejects.toThrow(
      "Gift media runtime unavailable",
    );
    await flush();
    fixture.server.emit("error", new Error("private listen failure"));
    fixture.completeHttp(
      Object.assign(new Error("server did not bind"), {
        code: "ERR_SERVER_NOT_RUNNING",
      }),
    );
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    pending.resolve();
    await failure;
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
  });

  it("retains resources on a runtime error and reports only after settled cleanup", async () => {
    const fixture = runtimeFixture();
    const pending = deferred();
    fixture.media.close.mockImplementation(() => pending.promise);
    const runtime = startGiftMediaRuntime(fixture.options);
    await flush();
    fixture.server.emit("listening");
    await runtime.ready;
    fixture.server.emit("error", new Error("private runtime failure"));
    fixture.completeHttp();
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    pending.resolve();
    await runtime.close();
    expect(fixture.options.onError).toHaveBeenCalled();
  });

  it("settled storage disposal failure cannot skip HTTP and single DB disposal", async () => {
    const fixture = runtimeFixture();
    fixture.media.close.mockRejectedValue(new Error("private storage detail"));
    const runtime = startGiftMediaRuntime(fixture.options);
    await flush();
    fixture.server.emit("listening");
    await runtime.ready;
    const closing = runtime.close();
    const failure = expect(closing).rejects.toThrow(
      "Gift media runtime unavailable",
    );
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    fixture.completeHttp();
    await failure;
    expect(fixture.closeDatabase).toHaveBeenCalledOnce();
    expect(runtime.close()).toBe(closing);
  });

  it("an unclassified HTTP close error cannot prove requests have drained", async () => {
    const fixture = runtimeFixture();
    const runtime = startGiftMediaRuntime(fixture.options);
    await flush();
    fixture.server.emit("listening");
    await runtime.ready;
    const closing = runtime.close();
    fixture.completeHttp(new Error("unproved HTTP completion"));
    await flush();
    expect(fixture.closeDatabase).not.toHaveBeenCalled();
    expect(runtime.close()).toBe(closing);
  });
});

async function applicationRuntimeFixture() {
  const fixture = runtimeFixture();
  const { createApp } = await import("./app");
  const application = createApp();
  application.get("/runtime-owned", (context) => context.text("application"));
  const closeApplication = vi.fn(application.close.bind(application));
  application.close = closeApplication;
  const createApplication = vi.fn(
    async (
      _ports: typeof fixture.media.ports,
      _auth: AuthHttpOptions["auth"],
    ) => application,
  );
  const options = {
    ...fixture.options,
    createFetch: undefined,
    createApplication,
  };
  return {
    ...fixture,
    application,
    closeApplication,
    createApplication,
    options,
  };
}
function observeRuntime(promise: Promise<unknown>) {
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
async function finishApplicationRuntime(
  fixture: Awaited<ReturnType<typeof applicationRuntimeFixture>>,
  runtime: ReturnType<typeof startGiftMediaRuntime>,
  releases: (() => void)[] = [],
) {
  for (const release of releases) release();
  const closing = runtime.close();
  observeRuntime(closing);
  await flush();
  if (fixture.closeHttp.mock.calls.length) fixture.completeHttp();
  await Promise.allSettled([runtime.ready, closing]);
}

describe("async real application ownership with synthetic runtime", () => {
  it("awaits application creation and actual listening, preserving the legacy fetch alternative", async () => {
    const fixture = await applicationRuntimeFixture();
    const creation = deferred<typeof fixture.application>();
    fixture.createApplication.mockImplementation(() => creation.promise);
    const runtime = startGiftMediaRuntime(fixture.options);
    const ready = observeRuntime(runtime.ready);
    try {
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledExactlyOnceWith(
        fixture.media.ports,
        await fixture.options.initialize.mock.results[0]?.value,
      );
      expect(fixture.createFetch).not.toHaveBeenCalled();
      expect(fixture.options.createServer).not.toHaveBeenCalled();
      expect(ready()).toBe(false);
      creation.resolve(fixture.application);
      await flush();
      expect(fixture.listen).toHaveBeenCalledExactlyOnceWith(8080);
      expect(ready()).toBe(false);
      fixture.server.emit("listening");
      await runtime.ready;
      const guarded = fixture.options.createServer.mock.calls[0]?.[0].fetch;
      const response = await guarded?.(
        new Request("https://api.example.test/runtime-owned"),
        {} as never,
      );
      expect(await (response as Response).text()).toBe("application");
    } finally {
      await finishApplicationRuntime(fixture, runtime, [
        () => creation.resolve(fixture.application),
      ]);
    }
    expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
    expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
  });
  it.each(["caller", "SIGTERM", "SIGINT"] as const)(
    "retains late acquisition through %s while blocking subsequent server creation",
    async (trigger) => {
      const fixture = await applicationRuntimeFixture();
      const creation = deferred<typeof fixture.application>();
      const history = deferred();
      fixture.createApplication.mockImplementation(() => creation.promise);
      fixture.closeApplication.mockImplementation(() => history.promise);
      const runtime = startGiftMediaRuntime(fixture.options);
      observeRuntime(runtime.ready);
      try {
        await flush();
        expect(fixture.createApplication).toHaveBeenCalledTimes(1);
        if (trigger !== "caller") fixture.signals.emit(trigger);
        const closing = runtime.close();
        const stopped = observeRuntime(closing);
        await flush();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        creation.resolve(fixture.application);
        await flush();
        expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
        expect(fixture.options.createServer).not.toHaveBeenCalled();
        expect(fixture.listen).not.toHaveBeenCalled();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        expect(stopped()).toBe(false);
        history.resolve();
        await closing;
        await expect(runtime.ready).rejects.toThrow(
          "Gift media runtime unavailable",
        );
      } finally {
        await finishApplicationRuntime(fixture, runtime, [
          () => creation.resolve(fixture.application),
          () => history.resolve(),
        ]);
      }
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["HTTP", "history", "media"],
    ["HTTP", "media", "history"],
    ["history", "HTTP", "media"],
    ["history", "media", "HTTP"],
    ["media", "HTTP", "history"],
    ["media", "history", "HTTP"],
  ])(
    "drains %s then %s then %s before releasing the database",
    async (first, second, third) => {
      const fixture = await applicationRuntimeFixture();
      const history = deferred();
      const media = deferred();
      fixture.closeApplication.mockImplementation(() => history.promise);
      fixture.media.close.mockImplementation(() => media.promise);
      const runtime = startGiftMediaRuntime(fixture.options);
      observeRuntime(runtime.ready);
      try {
        await flush();
        expect(fixture.createApplication).toHaveBeenCalledTimes(1);
        fixture.server.emit("listening");
        await runtime.ready;
        const closing = runtime.close();
        observeRuntime(closing);
        const guarded = fixture.options.createServer.mock.calls[0]?.[0].fetch;
        const response = await guarded?.(
          new Request("https://api.example.test/runtime-owned"),
          {} as never,
        );
        expect((response as Response).status).toBe(503);
        expect((response as Response).headers.get("cache-control")).toBe(
          "no-store",
        );
        expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
        const release = (owner: string) => {
          if (owner === "HTTP") fixture.completeHttp();
          if (owner === "history") history.resolve();
          if (owner === "media") media.resolve();
        };
        release(first);
        await flush();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        release(second);
        await flush();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        release(third);
        await closing;
        expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        await finishApplicationRuntime(fixture, runtime, [
          () => history.resolve(),
          () => media.resolve(),
        ]);
      }
    },
  );
  it.each(["throw", "reject"] as const)(
    "creation %s retains acquired media cleanup and sanitizes readiness failure",
    async (fault) => {
      const fixture = await applicationRuntimeFixture();
      const media = deferred();
      fixture.media.close.mockImplementation(() => media.promise);
      fixture.createApplication.mockImplementation(() => {
        if (fault === "throw") throw new Error("private construction failure");
        return Promise.reject(new Error("private construction failure"));
      });
      const runtime = startGiftMediaRuntime(fixture.options);
      const settled = observeRuntime(runtime.ready);
      try {
        await flush();
        expect(fixture.createApplication).toHaveBeenCalledTimes(1);
        expect(fixture.options.createServer).not.toHaveBeenCalled();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        expect(settled()).toBe(false);
        media.resolve();
        await expect(runtime.ready).rejects.toThrow(
          /^Gift media runtime unavailable$/,
        );
      } finally {
        await finishApplicationRuntime(fixture, runtime, [
          () => media.resolve(),
        ]);
      }
      expect(fixture.closeApplication).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    },
  );
  it("captures history close before a later fetch getter fails", async () => {
    const fixture = await applicationRuntimeFixture();
    const history = deferred();
    fixture.closeApplication.mockImplementation(() => history.promise);
    Object.defineProperty(fixture.application, "fetch", {
      get: () => {
        throw new Error("private fetch getter");
      },
    });
    const runtime = startGiftMediaRuntime(fixture.options);
    const settled = observeRuntime(runtime.ready);
    try {
      await flush();
      expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      expect(settled()).toBe(false);
      history.resolve();
      await expect(runtime.ready).rejects.toThrow(
        /^Gift media runtime unavailable$/,
      );
    } finally {
      await finishApplicationRuntime(fixture, runtime, [
        () => history.resolve(),
      ]);
    }
  });
  it.each(["throw", "reject", "invalid", "pending"] as const)(
    "does not certify pool release for %s app disposal",
    async (fault) => {
      const fixture = await applicationRuntimeFixture();
      const history = deferred();
      fixture.closeApplication.mockImplementation(() => {
        if (fault === "throw") throw new Error("private close failure");
        if (fault === "invalid") return undefined as never;
        return history.promise;
      });
      const runtime = startGiftMediaRuntime(fixture.options);
      observeRuntime(runtime.ready);
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledTimes(1);
      fixture.server.emit("listening");
      await runtime.ready;
      const closing = runtime.close();
      const stopped = observeRuntime(closing);
      expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
      if (fault === "reject")
        history.reject(new Error("private close rejection"));
      fixture.completeHttp();
      await flush();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      expect(stopped()).toBe(false);
      expect(runtime.close()).toBe(closing);
      if (fault === "pending") {
        history.resolve();
        await closing;
      }
      // Other cases hold only explicitly synthetic owners, with no live IO.
    },
  );
  it("known media rejection cannot skip pending history and HTTP owners", async () => {
    const fixture = await applicationRuntimeFixture();
    const history = deferred();
    fixture.closeApplication.mockImplementation(() => history.promise);
    fixture.media.close.mockRejectedValue(
      new Error("drained storage disposal"),
    );
    const runtime = startGiftMediaRuntime(fixture.options);
    observeRuntime(runtime.ready);
    try {
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledTimes(1);
      fixture.server.emit("listening");
      await runtime.ready;
      const closing = runtime.close();
      observeRuntime(closing);
      fixture.completeHttp();
      await flush();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      history.resolve();
      await expect(closing).rejects.toThrow(/^Gift media runtime unavailable$/);
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      await finishApplicationRuntime(fixture, runtime, [
        () => history.resolve(),
      ]);
    }
  });
  it("captures app close and memoizes shutdown before reentrant signals", async () => {
    const fixture = await applicationRuntimeFixture();
    const history = deferred();
    const runtime = startGiftMediaRuntime(fixture.options);
    observeRuntime(runtime.ready);
    let reentered!: Promise<void>;
    fixture.closeApplication.mockImplementation(() => {
      reentered = runtime.close();
      fixture.signals.emit("SIGTERM");
      return history.promise;
    });
    try {
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledTimes(1);
      fixture.server.emit("listening");
      await runtime.ready;
      fixture.application.close = vi.fn(async () => {});
      const closing = runtime.close();
      expect(reentered).toBe(closing);
      fixture.signals.emit("SIGINT");
      expect(fixture.closeApplication).toHaveBeenCalledTimes(1);
      expect(fixture.application.close).not.toHaveBeenCalled();
      fixture.completeHttp();
      history.resolve();
      await closing;
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
      expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
      expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
      expect(fixture.server.listenerCount("error")).toBe(0);
      expect(fixture.server.listenerCount("listening")).toBe(0);
    } finally {
      await finishApplicationRuntime(fixture, runtime, [
        () => history.resolve(),
      ]);
    }
  });
  it("rejects a runtime with both creation alternatives without invoking either", async () => {
    const fixture = await applicationRuntimeFixture();
    const runtime = startGiftMediaRuntime({
      ...fixture.options,
      createFetch: fixture.createFetch,
    } as never);
    observeRuntime(runtime.ready);
    try {
      await flush();
      expect(fixture.createFetch).not.toHaveBeenCalled();
      expect(fixture.createApplication).not.toHaveBeenCalled();
    } finally {
      await finishApplicationRuntime(fixture, runtime);
    }
    await expect(runtime.ready).rejects.toThrow(
      /^Gift media runtime unavailable$/,
    );
  });
  it("observes a media rejection immediately while application creation remains pending", async () => {
    const fixture = await applicationRuntimeFixture();
    const creation = deferred<typeof fixture.application>();
    const media = deferred();
    let observed = false;
    const then = media.promise.then.bind(media.promise);
    vi.spyOn(media.promise, "then").mockImplementation((yes, no) => {
      observed = true;
      return then(yes, no);
    });
    fixture.createApplication.mockImplementation(() => creation.promise);
    fixture.media.close.mockImplementation(() => media.promise);
    const runtime = startGiftMediaRuntime(fixture.options);
    observeRuntime(runtime.ready);
    try {
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledTimes(1);
      const closing = runtime.close();
      observeRuntime(closing);
      expect(observed).toBe(true);
      media.reject(new Error("known drained storage failure"));
      await flush();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      creation.resolve(fixture.application);
      await expect(closing).rejects.toThrow(/^Gift media runtime unavailable$/);
      await expect(runtime.ready).rejects.toThrow(
        /^Gift media runtime unavailable$/,
      );
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      await finishApplicationRuntime(fixture, runtime, [
        () => creation.resolve(fixture.application),
        () => media.resolve(),
      ]);
    }
  });
  it.each(["getter", "missing"] as const)(
    "retains an acquired app with a %s closer instead of releasing the pool",
    async (fault) => {
      const fixture = await applicationRuntimeFixture();
      if (fault === "getter")
        Object.defineProperty(fixture.application, "close", {
          get: () => {
            throw new Error("private closer getter");
          },
        });
      else fixture.application.close = undefined as never;
      const runtime = startGiftMediaRuntime(fixture.options);
      const settled = observeRuntime(runtime.ready);
      await flush();
      expect(fixture.createApplication).toHaveBeenCalledTimes(1);
      expect(fixture.options.createServer).not.toHaveBeenCalled();
      expect(fixture.closeDatabase).not.toHaveBeenCalled();
      expect(settled()).toBe(false);
      observeRuntime(runtime.close());
      // The acquired synthetic app has no live requests, socket or database.
    },
  );
  it.each(["context", "schema"] as const)(
    "retains actual private SDK construction with a synthetic %s barrier until real close",
    async (phase) => {
      const fixture = await applicationRuntimeFixture();
      const { createAuth, createSessionReadAuth } = await import("./auth");
      const { createGiftPaymentHistoryApplication } = await import(
        "./giftPaymentHistoryComposition"
      );
      const contextGate = deferred();
      const schemaGate = deferred();
      const db = {} as Parameters<typeof createAuth>[0]["db"];
      const authentication = {
        db,
        secret: "fictional-runtime-history-secret-at-least-32",
        baseURL: "https://api.example.test",
        adminOrigin: "https://admin.example.test",
      };
      const standardAuth = createAuth(authentication);
      const normalContext = await standardAuth.$context;
      await normalContext.checkSchema?.();
      fixture.options.initialize.mockResolvedValue(standardAuth);
      let actualContext!: ReturnType<typeof createSessionReadAuth>["$context"];
      const checkSchema = vi.fn();
      const createReadAuth = vi.fn<typeof createSessionReadAuth>((options) => {
        const native = createSessionReadAuth(options);
        actualContext = native.$context;
        native.$context = Promise.all([
          actualContext,
          contextGate.promise,
        ]).then(([context]) => ({
          ...context,
          checkSchema: () => {
            checkSchema();
            return schemaGate.promise.then(() => context.checkSchema?.());
          },
        }));
        return native;
      });
      fixture.createApplication.mockImplementation((_media, auth) =>
        createGiftPaymentHistoryApplication(
          {
            mode: "sandbox",
            applicationEnvironment: "test",
            policy: "SITE_HISTORY",
          },
          {
            ...authentication,
            standardAuth: auth,
            now: () => new Date("2026-10-13T14:00:00Z"),
            createReadAuth,
          },
          { auth, db, adminOrigin: authentication.adminOrigin },
        ),
      );
      const runtime = startGiftMediaRuntime(fixture.options);
      observeRuntime(runtime.ready);
      try {
        await flush();
        expect(createReadAuth).toHaveBeenCalledTimes(1);
        if (phase === "schema") {
          contextGate.resolve();
          await actualContext;
          await flush();
          expect(checkSchema).toHaveBeenCalledTimes(1);
        }
        fixture.signals.emit("SIGTERM");
        const closing = runtime.close();
        const stopped = observeRuntime(closing);
        await flush();
        expect(fixture.options.createServer).not.toHaveBeenCalled();
        expect(fixture.closeDatabase).not.toHaveBeenCalled();
        expect(stopped()).toBe(false);
        contextGate.resolve();
        schemaGate.resolve();
        await closing;
        await expect(runtime.ready).rejects.toThrow(
          /^Gift media runtime unavailable$/,
        );
        expect(checkSchema).toHaveBeenCalledTimes(1);
        expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        await finishApplicationRuntime(fixture, runtime, [
          () => contextGate.resolve(),
          () => schemaGate.resolve(),
        ]);
      }
    },
  );
  it.each(["legacy", "application"] as const)(
    "preserves the original options receiver in the %s creation method",
    async (branch) => {
      const fixture = await applicationRuntimeFixture();
      const options =
        branch === "legacy"
          ? {
              ...fixture.options,
              createApplication: undefined,
              createFetch: fixture.createFetch,
            }
          : fixture.options;
      let receiver: unknown;
      if (branch === "legacy") {
        fixture.createFetch.mockImplementation(function (this: typeof options) {
          receiver = this;
          if (this?.port !== 8080) throw new Error("missing legacy receiver");
          return fixture.fetch;
        });
      } else {
        fixture.createApplication.mockImplementation(async function (
          this: typeof options,
        ) {
          receiver = this;
          if (this?.port !== 8080)
            throw new Error("missing application receiver");
          return fixture.application;
        });
      }
      const runtime = startGiftMediaRuntime(options);
      observeRuntime(runtime.ready);
      try {
        await flush();
        expect(receiver).toBe(options);
        expect(fixture.listen).toHaveBeenCalledExactlyOnceWith(8080);
        fixture.server.emit("listening");
        await runtime.ready;
      } finally {
        await finishApplicationRuntime(fixture, runtime);
      }
      expect(fixture.closeDatabase).toHaveBeenCalledTimes(1);
    },
  );
});
