import { isPromise } from "node:util/types";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import type { createApp } from "./app";
import type { AuthHttpOptions } from "./authHttp";
import { decodeGiftImage } from "./giftImageDecoder";
import {
  createGiftMediaProcessing,
  type GiftMediaProcessing,
} from "./giftMedia";
import type { GiftMediaConfig } from "./giftMediaConfig";
import type { GiftMediaHttpOptions } from "./giftMediaHttp";
import {
  createR2GiftMediaStorage,
  type GiftMediaStorage,
} from "./giftMediaStorage";

type MediaPorts = Pick<
  GiftMediaHttpOptions,
  "storage" | "storageNamespace" | "processing" | "decode"
> & { giftMediaAuth?: AuthHttpOptions["auth"] };
export interface GiftMediaComposition {
  readonly ports: Readonly<MediaPorts>;
  close(): Promise<void>;
}
interface CompositionOptions {
  createReadAuth(): AuthHttpOptions["auth"];
  createStorage?: typeof createR2GiftMediaStorage;
  createProcessing?: typeof createGiftMediaProcessing;
  decode?: typeof decodeGiftImage;
}

async function settleAuthInitialization(auth: AuthHttpOptions["auth"]) {
  const context = await auth.$context;
  try {
    // The installed adapter shares the schema promise; the SDK logs its verdict.
    await context?.checkSchema?.();
  } catch {
    // Preserve Better Auth's existing initialization schema-error policy.
  }
}

function mediaCloser(
  processing?: GiftMediaProcessing,
  storage?: GiftMediaStorage,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let drain: Promise<void>;
    try {
      drain = processing?.close() ?? Promise.resolve();
    } catch {
      return closing;
    }
    void (async () => {
      try {
        await drain;
      } catch {
        // A rejected pipeline drain does not prove its owned work has settled.
        await new Promise<void>(() => {});
      }
      try {
        await storage?.close();
      } catch {
        throw new Error("Gift media composition unavailable");
      }
    })().then(resolve, reject);
    return closing;
  };
}

export async function createGiftMediaComposition(
  config: GiftMediaConfig,
  options: CompositionOptions,
): Promise<GiftMediaComposition> {
  if (config.mode === "disabled")
    return Object.freeze({ ports: Object.freeze({}), close: mediaCloser() });
  let storage: GiftMediaStorage | undefined;
  let processing: GiftMediaProcessing | undefined;
  try {
    const captured = {
      accountId: config.accountId,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucketName: config.bucketName,
      publicOrigin: config.publicOrigin,
    };
    storage = (options.createStorage ?? createR2GiftMediaStorage)(captured);
    processing = (options.createProcessing ?? createGiftMediaProcessing)();
    const decode = options.decode ?? decodeGiftImage;
    const giftMediaAuth = options.createReadAuth();
    await settleAuthInitialization(giftMediaAuth);
    return Object.freeze({
      ports: Object.freeze({
        storage,
        storageNamespace: storage.storageNamespace,
        processing,
        decode,
        giftMediaAuth,
      }),
      close: mediaCloser(processing, storage),
    });
  } catch {
    try {
      await mediaCloser(processing, storage)();
    } catch {
      // Acquired resources have settled even when their disposal reports failure.
    }
    throw new Error("Gift media composition unavailable");
  }
}

type Fetch = Parameters<typeof createAdaptorServer>[0]["fetch"];
type RuntimeOptions = {
  initialize(): Promise<AuthHttpOptions["auth"]>;
  createMedia(): Promise<GiftMediaComposition>;
  createServer?: typeof createAdaptorServer;
  port: number;
  closeDatabase(): Promise<void>;
  signals?: {
    on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
    off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  };
  onError?(): void;
} & (
  | {
      createFetch(
        ports: GiftMediaComposition["ports"],
        auth: AuthHttpOptions["auth"],
      ): Fetch;
      createApplication?: never;
    }
  | {
      createApplication(
        ports: GiftMediaComposition["ports"],
        auth: AuthHttpOptions["auth"],
      ): Promise<ReturnType<typeof createApp>>;
      createFetch?: never;
    }
);

export function startGiftMediaRuntime(options: RuntimeOptions): {
  ready: Promise<void>;
  close(): Promise<void>;
} {
  const signals = options.signals ?? process;
  let server: ServerType | undefined;
  let media: GiftMediaComposition | undefined;
  let application: ReturnType<typeof createApp> | undefined;
  let applicationAcquired = false;
  let applicationClose: (() => Promise<void>) | undefined;
  let applicationClosing: Promise<void> | undefined;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  let httpClosing: Promise<void> | undefined;
  let mediaClosing: Promise<void> | undefined;
  let cancelListening: (() => void) | undefined;
  let listening: (() => void) | undefined;
  let startupSettled!: () => void;
  const startupCompletion = new Promise<void>((resolve) => {
    startupSettled = resolve;
  });
  const unavailable = () => new Error("Gift media runtime unavailable");
  const closeHttp = () => {
    if (!server || httpClosing) return;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    httpClosing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void httpClosing.catch(() => {});
    try {
      server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        )
          return;
        if (error) reject(unavailable());
        else resolve();
      });
    } catch {
      // A thrown close does not prove that HTTP work has finished.
      httpClosing = new Promise<void>(() => {});
    }
  };
  const closeMedia = () => {
    if (!media || mediaClosing) return;
    try {
      mediaClosing = media.close();
      void mediaClosing.catch(() => {});
    } catch {
      // Keep dependencies while a broken drain cannot prove actual settlement.
      mediaClosing = new Promise<void>(() => {});
    }
  };
  const closeApplication = () => {
    if (!applicationAcquired || applicationClosing) return;
    let resolve!: () => void;
    applicationClosing = new Promise<void>((yes) => {
      resolve = yes;
    });
    try {
      const actual = applicationClose?.();
      if (isPromise(actual)) void actual.then(resolve, () => {});
    } catch {
      // Uncertain application disposal retains shared dependencies.
    }
  };
  const close = () => {
    if (closePromise) return closePromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closePromise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    stopping = true;
    cancelListening?.();
    closeHttp();
    closeApplication();
    closeMedia();
    void (async () => {
      await startupCompletion;
      closeHttp();
      closeApplication();
      closeMedia();
      const results = await Promise.allSettled([
        httpClosing,
        applicationClosing,
        mediaClosing,
      ]);
      let failed = results.some((result) => result.status === "rejected");
      try {
        await options.closeDatabase();
      } catch {
        failed = true;
      } finally {
        signals.off("SIGTERM", stop);
        signals.off("SIGINT", stop);
        if (server) {
          server.off("error", serverError);
          if (listening) server.off("listening", listening);
        }
      }
      if (failed) throw unavailable();
    })().then(resolve, reject);
    return closePromise;
  };
  const stop = () => {
    void close().catch(() => options.onError?.());
  };
  const serverError = () => {
    cancelListening?.();
    void close().then(
      () => options.onError?.(),
      () => options.onError?.(),
    );
  };
  const startup = (async () => {
    try {
      signals.on("SIGTERM", stop);
      signals.on("SIGINT", stop);
      const auth = await options.initialize();
      await settleAuthInitialization(auth);
      if (stopping) throw unavailable();
      media = await options.createMedia();
      if (stopping) throw unavailable();
      const createApplication = options.createApplication;
      const createFetch = options.createFetch;
      let fetch: Fetch;
      if (
        typeof createApplication === "function" &&
        createFetch === undefined
      ) {
        const creation = createApplication.call(options, media.ports, auth);
        if (!isPromise(creation)) await new Promise<never>(() => {});
        application = await creation;
        applicationAcquired = true;
        const close = application.close;
        if (typeof close !== "function") throw unavailable();
        applicationClose = close.bind(application);
        if (stopping) throw unavailable();
        fetch = application.fetch;
        if (typeof fetch !== "function") throw unavailable();
      } else if (
        createApplication === undefined &&
        typeof createFetch === "function"
      ) {
        fetch = createFetch.call(options, media.ports, auth);
      } else throw unavailable();
      if (stopping) throw unavailable();
      server = (options.createServer ?? createAdaptorServer)({
        fetch: (request, environment) =>
          stopping
            ? new Response(null, {
                status: 503,
                headers: { "Cache-Control": "no-store" },
              })
            : fetch(request, environment),
      });
      if (stopping) throw unavailable();
      server.on("error", serverError);
      await new Promise<void>((resolve, reject) => {
        cancelListening = () => reject(unavailable());
        listening = () => {
          if (stopping) reject(unavailable());
          else resolve();
        };
        server?.once("listening", listening);
        server?.listen(options.port);
      });
      cancelListening = undefined;
      if (stopping) throw unavailable();
    } finally {
      startupSettled();
    }
  })();
  const ready = startup.catch(async () => {
    try {
      await close();
    } catch {
      // Startup and disposal failures share one generic error boundary.
    }
    throw unavailable();
  });
  return Object.freeze({ ready, close });
}
