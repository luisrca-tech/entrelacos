import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const maxBytes = 5_242_880;
const operationTimeoutMs = 10_000;
export type GiftUploadContentType = "image/jpeg" | "image/png" | "image/webp";
export interface GiftDerivativeHead {
  etag: string;
  byteLength: number;
  contentType: "image/webp";
}
export interface GiftMediaStorage {
  readonly storageNamespace: string;
  getDerivativeUrl(derivativeKey: string): string;
  headDerivative(
    derivativeKey: string,
    signal?: AbortSignal,
  ): Promise<GiftDerivativeHead>;
  readDerivative(
    derivativeKey: string,
    etag: string,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  publishDerivative(
    derivativeKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ url: string }>;
  close(): Promise<void>;
}
export interface R2GiftMediaStorageOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicOrigin: string;
  applicationEnvironment?: "development" | "test" | "production";
}
export class GiftMediaStorageError extends Error {
  constructor(
    readonly status: 400 | 404 | 412 | 503,
    readonly code:
      | "GIFT_MEDIA_INVALID"
      | "GIFT_MEDIA_NOT_FOUND"
      | "GIFT_MEDIA_CONFLICT"
      | "MEDIA_STORAGE_UNAVAILABLE",
  ) {
    super(
      status === 400
        ? "Imagem inválida ou não suportada."
        : "Armazenamento de imagens indisponível.",
    );
    this.name = "GiftMediaStorageError";
  }
}
function invalid(): never {
  throw new GiftMediaStorageError(400, "GIFT_MEDIA_INVALID");
}
function unavailable(): never {
  throw new GiftMediaStorageError(503, "MEDIA_STORAGE_UNAVAILABLE");
}
function bytesValid(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maxBytes
  );
}
function keyValid(key: string): void {
  if (
    typeof key !== "string" ||
    key.length > 512 ||
    !/^gifts\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+\/[A-Za-z0-9_-]+\.webp$/.test(
      key,
    ) ||
    key.split("/").some((part) => part === "." || part === "..")
  )
    invalid();
}
function validEtag(value: unknown): value is string {
  return typeof value === "string" && /^"[^"\\\r\n]{1,128}"$/.test(value);
}
function safeConfig(options: R2GiftMediaStorageOptions): URL {
  try {
    const origin = new URL(options.publicOrigin);
    const developmentPublicOrigin =
      (options.applicationEnvironment === "development" ||
        options.applicationEnvironment === "test") &&
      /^[a-z0-9-]+\.r2\.dev$/i.test(origin.hostname);
    if (
      !/^[a-f0-9]{32}$/i.test(options.accountId) ||
      !options.accessKeyId.trim() ||
      !options.secretAccessKey.trim() ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucketName) ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      origin.hostname.endsWith(".") ||
      (/(^|\.)r2\.dev$/i.test(origin.hostname) && !developmentPublicOrigin) ||
      /(^|\.)r2\.cloudflarestorage\.com$/i.test(origin.hostname)
    )
      unavailable();
    return origin;
  } catch {
    unavailable();
  }
}
function sanitize(error: unknown): never {
  if (error instanceof GiftMediaStorageError) throw error;
  if (error && typeof error === "object" && "$metadata" in error) {
    const metadata = error.$metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      "httpStatusCode" in metadata
    ) {
      if (metadata.httpStatusCode === 404)
        throw new GiftMediaStorageError(404, "GIFT_MEDIA_NOT_FOUND");
      if (metadata.httpStatusCode === 412)
        throw new GiftMediaStorageError(412, "GIFT_MEDIA_CONFLICT");
    }
  }
  unavailable();
}
function current(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
}

export function createR2GiftMediaStorage(
  options: R2GiftMediaStorageOptions,
): GiftMediaStorage {
  options = { ...options };
  const publicOrigin = safeConfig(options);
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const active = new Set<{
    abort: AbortController;
    completion: Promise<void>;
  }>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function run<T>(
    signal: AbortSignal | undefined,
    operation: (abort: AbortController) => Promise<T>,
  ): Promise<T> {
    if (closing || signal?.aborted)
      return Promise.reject(
        new GiftMediaStorageError(503, "MEDIA_STORAGE_UNAVAILABLE"),
      );
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, operationTimeoutMs);
    let completed!: () => void;
    const owned = {
      abort,
      completion: new Promise<void>((resolve) => {
        completed = resolve;
      }),
    };
    active.add(owned);
    return (async () => {
      try {
        current(abort.signal);
        const result = await operation(abort);
        current(abort.signal);
        return result;
      } catch (error) {
        abort.abort();
        if (signal?.aborted || closing) unavailable();
        return sanitize(error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        active.delete(owned);
        completed();
      }
    })();
  }

  async function readComplete(
    result: {
      ETag?: string;
      ContentLength?: number;
      ContentType?: string;
      Body?: unknown;
    },
    etag: string,
    byteLength: number,
    abort: AbortController,
  ): Promise<Uint8Array> {
    const stream = result.Body;
    const nodeCompletion =
      stream instanceof Readable
        ? finished(stream, { cleanup: true }).catch(() => {})
        : undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let canceled: Promise<void> | undefined;
    const cancel = () => {
      if (reader) {
        canceled ??= reader.cancel().then(
          () => {},
          () => {},
        );
      } else if (
        stream &&
        typeof stream === "object" &&
        "destroy" in stream &&
        typeof stream.destroy === "function"
      ) {
        try {
          stream.destroy();
        } catch {
          /* Keep actual read settlement owned. */
        }
      }
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (
        stream &&
        typeof stream === "object" &&
        "getReader" in stream &&
        typeof stream.getReader === "function"
      ) {
        reader = (stream as ReadableStream<Uint8Array>).getReader();
      }
      if (abort.signal.aborted) cancel();
      current(abort.signal);
      if (
        result.ETag !== etag ||
        result.ContentLength !== byteLength ||
        result.ContentType !== "image/webp" ||
        !stream
      )
        invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const append = (chunk: unknown) => {
        current(abort.signal);
        if (!(chunk instanceof Uint8Array)) invalid();
        size += chunk.byteLength;
        if (size > byteLength) invalid();
        chunks.push(Buffer.from(chunk));
      };
      if (reader) {
        while (true) {
          current(abort.signal);
          const chunk = await reader.read();
          current(abort.signal);
          if (chunk.done) break;
          append(chunk.value);
        }
      } else {
        if (
          typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !==
          "function"
        )
          invalid();
        for await (const chunk of stream as AsyncIterable<Uint8Array>)
          append(chunk);
      }
      current(abort.signal);
      if (size !== byteLength) invalid();
      return Buffer.concat(chunks, size);
    } catch (error) {
      abort.abort();
      throw error;
    } finally {
      if (canceled) await canceled;
      if (nodeCompletion) await nodeCompletion;
      reader?.releaseLock();
      abort.signal.removeEventListener("abort", cancel);
    }
  }

  const getDerivativeUrl = (derivativeKey: string) => {
    keyValid(derivativeKey);
    return new URL(derivativeKey, publicOrigin).toString();
  };
  return Object.freeze({
    storageNamespace: options.bucketName,
    getDerivativeUrl,
    headDerivative: (derivativeKey: string, signal?: AbortSignal) =>
      run(signal, async (abort) => {
        keyValid(derivativeKey);
        const result = await client.send(
          new HeadObjectCommand({
            Bucket: options.bucketName,
            Key: derivativeKey,
          }),
          { abortSignal: abort.signal },
        );
        current(abort.signal);
        if (
          !validEtag(result.ETag) ||
          !bytesValid(result.ContentLength) ||
          result.ContentType !== "image/webp"
        )
          invalid();
        return {
          etag: result.ETag,
          byteLength: result.ContentLength,
          contentType: "image/webp" as const,
        };
      }),
    readDerivative: (
      derivativeKey: string,
      etag: string,
      byteLength: number,
      signal?: AbortSignal,
    ) =>
      run(signal, async (abort) => {
        keyValid(derivativeKey);
        if (!validEtag(etag) || !bytesValid(byteLength)) invalid();
        const result = await client.send(
          new GetObjectCommand({
            Bucket: options.bucketName,
            Key: derivativeKey,
            IfMatch: etag,
          }),
          { abortSignal: abort.signal },
        );
        return readComplete(result, etag, byteLength, abort);
      }),
    publishDerivative: (
      derivativeKey: string,
      bytes: Uint8Array,
      signal?: AbortSignal,
    ) =>
      run(signal, async (abort) => {
        const url = getDerivativeUrl(derivativeKey);
        if (!(bytes instanceof Uint8Array) || !bytesValid(bytes.byteLength))
          invalid();
        const snapshot = Buffer.from(bytes);
        await client.send(
          new PutObjectCommand({
            Bucket: options.bucketName,
            Key: derivativeKey,
            Body: snapshot,
            ContentType: "image/webp",
            ContentLength: snapshot.byteLength,
            IfNoneMatch: "*",
            CacheControl: "public, max-age=31536000, immutable",
          }),
          { abortSignal: abort.signal },
        );
        return { url };
      }),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      closePromise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      for (const owned of active) owned.abort.abort();
      void Promise.allSettled(Array.from(active, (owned) => owned.completion))
        .then(() => {
          try {
            client.destroy();
          } catch {
            unavailable();
          }
        })
        .then(resolve, reject);
      return closePromise;
    },
  });
}
