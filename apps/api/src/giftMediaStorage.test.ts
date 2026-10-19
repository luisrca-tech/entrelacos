import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
  options: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    send = mocks.send;
    destroy = mocks.destroy;
  },
}));

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createR2GiftMediaStorage,
  type GiftMediaStorage,
  GiftMediaStorageError,
} from "./giftMediaStorage";

const options = {
  accountId: "a".repeat(32),
  accessKeyId: "private-key",
  secretAccessKey: "private-secret",
  bucketName: "existing-gifts",
  publicOrigin: "https://media.example.test",
};
const key = "gifts/wedding-a/asset-a/processing-a.webp";
const etag = '"stable-version"';
const bytes = Buffer.from("RIFF0000WEBPvalidated-derivative");
const opened: GiftMediaStorage[] = [];
const head = () => ({
  ETag: etag,
  ContentLength: bytes.length,
  ContentType: "image/webp",
});
async function* body(...chunks: Uint8Array[]) {
  yield* chunks;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function storage(patch = {}) {
  const value = createR2GiftMediaStorage({ ...options, ...patch });
  opened.push(value);
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden");
    }),
  );
});
afterEach(async () => {
  for (const value of opened.splice(0))
    if ("close" in value) await value.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("single existing bucket derivative storage", () => {
  it.each(["development", "test"] as const)(
    "supports development R2 public delivery with explicit %s scope",
    async (applicationEnvironment) => {
      const value = storage({
        applicationEnvironment,
        publicOrigin: "https://pub-development.r2.dev",
      });
      expect(value.getDerivativeUrl(key)).toBe(
        `https://pub-development.r2.dev/${key}`,
      );
      expect(mocks.send).not.toHaveBeenCalled();
      await value.close();
    },
  );
  it.each([
    {
      applicationEnvironment: "production",
      publicOrigin: "https://pub-development.r2.dev",
    },
    { applicationEnvironment: "development", publicOrigin: "https://r2.dev" },
    {
      applicationEnvironment: "development",
      publicOrigin: "http://pub-development.r2.dev",
    },
    {
      applicationEnvironment: "development",
      publicOrigin: "https://pub-development.r2.dev.",
    },
    {
      applicationEnvironment: "development",
      publicOrigin: "https://pub-development.r2.dev/path",
    },
    {
      applicationEnvironment: "development",
      publicOrigin: "https://account.r2.cloudflarestorage.com",
    },
    {
      applicationEnvironment: "test",
      publicOrigin: "https://account.r2.cloudflarestorage.com",
    },
  ])(
    "retains delivery origin restrictions for explicit scopes (%j)",
    (patch) => {
      expect(() => storage(patch)).toThrow(GiftMediaStorageError);
      expect(mocks.options).not.toHaveBeenCalled();
    },
  );
  it("captures one bucket and original URL before PUT, with no raw signing ports", async () => {
    const mutable = { ...options };
    const value = createR2GiftMediaStorage(mutable);
    opened.push(value);
    mutable.bucketName = "another-bucket";
    mutable.publicOrigin = "https://other.example.test";
    expect(value.storageNamespace).toBe("existing-gifts");
    expect(value.getDerivativeUrl(key)).toBe(
      `https://media.example.test/${key}`,
    );
    for (const name of ["signUpload", "headStaging", "readStaging"])
      expect(value).not.toHaveProperty(name);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        region: "auto",
        endpoint:
          "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
        forcePathStyle: true,
      }),
    );
    mocks.send.mockResolvedValue({});
    await value.publishDerivative(key, bytes);
    expect(mocks.send.mock.calls[0][0].input.Bucket).toBe("existing-gifts");
  });
  it.each([
    { bucketName: "bad/name" },
    { publicOrigin: "http://media.example.test" },
    { publicOrigin: "https://secret:pass@media.example.test" },
    { publicOrigin: "https://test.r2.dev" },
    { publicOrigin: "https://test.r2.dev." },
    { publicOrigin: "https://account.r2.cloudflarestorage.com" },
    { publicOrigin: "https://media.example.test/path" },
    { publicOrigin: "https://media.example.test/?token=secret" },
    { accountId: "../other" },
    { secretAccessKey: "" },
    { accessKeyId: " " },
  ])("refuses unsafe configuration before SDK creation: %j", (patch) => {
    expect(() => createR2GiftMediaStorage({ ...options, ...patch })).toThrow(
      GiftMediaStorageError,
    );
    expect(mocks.options).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("publishes a snapshot to the immutable original derivative with one SDK send", async () => {
    const value = storage();
    const waiting = deferred<object>();
    mocks.send.mockReturnValue(waiting.promise);
    const selected = new Uint8Array(bytes);
    const pending = value.publishDerivative(key, selected);
    selected.fill(0);
    const command = mocks.send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "existing-gifts",
      Key: key,
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: "image/webp",
      IfNoneMatch: "*",
      CacheControl: "public, max-age=31536000, immutable",
    });
    expect(command.input.Body).not.toBe(selected);
    waiting.resolve({});
    await expect(pending).resolves.toEqual({
      url: `https://media.example.test/${key}`,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    "staging/wedding-a/asset-a/nonce-a",
    "gifts/wedding-a/../processing-a.webp",
    "gifts/wedding-a/asset-a/raw.jpg",
    "https://foreign.test/file.webp",
  ])("rejects foreign/raw/unsafe keys before network: %s", async (bad) => {
    const value = storage();
    expect(() => value.getDerivativeUrl(bad)).toThrow(GiftMediaStorageError);
    await expect(value.publishDerivative(bad, bytes)).rejects.toMatchObject({
      status: 400,
    });
    await expect(value.headDerivative(bad)).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("reads only complete WebP bytes from the captured derivative and HEAD version", async () => {
    const value = storage();
    mocks.send.mockResolvedValueOnce(head());
    await expect(value.headDerivative(key)).resolves.toEqual({
      etag,
      byteLength: bytes.length,
      contentType: "image/webp",
    });
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    mocks.send.mockResolvedValueOnce({
      ...head(),
      Body: body(bytes.subarray(0, 10), bytes.subarray(10)),
    });
    await expect(
      value.readDerivative(key, etag, bytes.length),
    ).resolves.toEqual(bytes);
    const command = mocks.send.mock.calls[1][0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "existing-gifts",
      Key: key,
      IfMatch: etag,
    });
  });
  it.each([
    { ETag: undefined },
    { ETag: '"bad\nvalue"' },
    { ContentLength: 0 },
    { ContentLength: 5_242_881 },
    { ContentType: "image/png" },
    { ContentType: undefined },
  ])("rejects invalid derivative HEAD without GET: %j", async (patch) => {
    const value = storage();
    mocks.send.mockResolvedValueOnce({ ...head(), ...patch });
    await expect(value.headDerivative(key)).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    "changed",
    "truncated",
    "oversized",
    "wrong-mime",
    "missing-body",
    "bad-chunk",
  ])("rejects incomplete or changed readback: %s", async (fault) => {
    const value = storage();
    const response: Record<string, unknown> = { ...head(), Body: body(bytes) };
    if (fault === "changed") response.ETag = '"other"';
    if (fault === "truncated")
      response.Body = body(bytes.subarray(0, bytes.length - 1));
    if (fault === "oversized") response.Body = body(bytes, new Uint8Array([0]));
    if (fault === "wrong-mime") response.ContentType = "image/jpeg";
    if (fault === "missing-body") response.Body = undefined;
    if (fault === "bad-chunk") response.Body = body("private" as never);
    mocks.send.mockResolvedValueOnce(response);
    await expect(
      value.readDerivative(key, etag, bytes.length),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
  });
  it("distinguishes sanitized412 conflict and404 absence without retry or success", async () => {
    const value = storage();
    mocks.send.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 412 },
      message: "private-key",
    });
    await expect(value.publishDerivative(key, bytes)).rejects.toMatchObject({
      status: 412,
      code: "GIFT_MEDIA_CONFLICT",
    });
    mocks.send.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 404 },
      message: "private-key",
    });
    await expect(value.headDerivative(key)).rejects.toMatchObject({
      status: 404,
      code: "GIFT_MEDIA_NOT_FOUND",
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("sanitizes unknown SDK errors and does not retry", async () => {
    const value = storage();
    mocks.send.mockRejectedValueOnce(new Error("private-secret raw URL"));
    await expect(value.publishDerivative(key, bytes)).rejects.toMatchObject({
      status: 503,
      code: "MEDIA_STORAGE_UNAVAILABLE",
      message: "Armazenamento de imagens indisponível.",
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("denies an already canceled operation without dispatch", async () => {
    const value = storage();
    const abort = new AbortController();
    abort.abort();
    await expect(
      value.publishDerivative(key, bytes, abort.signal),
    ).rejects.toMatchObject({ status: 503 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("close aborts SDK work but waits for actual settlement before destroying", async () => {
    const value = storage();
    const waiting = deferred<object>();
    mocks.send.mockReturnValue(waiting.promise);
    const result = value.publishDerivative(key, bytes).catch((error) => error);
    const closing = value.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(mocks.destroy).not.toHaveBeenCalled();
    await expect(value.headDerivative(key)).rejects.toMatchObject({
      status: 503,
    });
    waiting.resolve({});
    expect(await result).toMatchObject({ status: 503 });
    await closing;
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    await value.close();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("caller abort cannot settle an ignored SDK promise early", async () => {
    const value = storage();
    const waiting = deferred<object>();
    mocks.send.mockReturnValue(waiting.promise);
    const abort = new AbortController();
    let settled = false;
    const result = value
      .publishDerivative(key, bytes, abort.signal)
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    waiting.resolve({});
    expect(await result).toMatchObject({ status: 503 });
  });
  it("a10s SDK deadline cancels without releasing underlying ownership", async () => {
    vi.useFakeTimers();
    const value = storage();
    const waiting = deferred<object>();
    mocks.send.mockReturnValue(waiting.promise);
    let settled = false;
    const result = value
      .publishDerivative(key, bytes)
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(settled).toBe(false);
    waiting.resolve({});
    expect(await result).toMatchObject({ status: 503 });
  });
  it("close owns a body iterator until its actual pending read ends", async () => {
    const value = storage();
    const waiting = deferred<Uint8Array>();
    const destroy = vi.fn();
    let entered = false;
    async function* delayed() {
      entered = true;
      yield await waiting.promise;
    }
    mocks.send.mockResolvedValueOnce({
      ...head(),
      Body: Object.assign(delayed(), { destroy }),
    });
    const result = value
      .readDerivative(key, etag, bytes.length)
      .catch((error) => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    const closing = value.close();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).not.toHaveBeenCalled();
    waiting.resolve(bytes);
    expect(await result).toMatchObject({ status: 503 });
    await closing;
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("cancels an active web body reader on upstream abort", async () => {
    const value = storage();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() {}, cancel });
    mocks.send.mockResolvedValueOnce({ ...head(), Body: stream });
    const abort = new AbortController();
    const result = value
      .readDerivative(key, etag, bytes.length, abort.signal)
      .catch((error) => error);
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    abort.abort();
    expect(await result).toMatchObject({ status: 503 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });
  it("destroys a late SDK body returned after cancellation without starting its iterator", async () => {
    const value = storage();
    const waiting = deferred<unknown>();
    mocks.send.mockReturnValue(waiting.promise);
    const abort = new AbortController();
    const destroy = vi.fn();
    const iterator = vi.fn();
    const result = value
      .readDerivative(key, etag, bytes.length, abort.signal)
      .catch((error) => error);
    abort.abort();
    waiting.resolve({
      ...head(),
      Body: { destroy, [Symbol.asyncIterator]: iterator },
    });
    expect(await result).toMatchObject({ status: 503 });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(iterator).not.toHaveBeenCalled();
  });
  it.each([0, 5_242_881])(
    "rejects invalid publish byte count %s before any send",
    async (size) => {
      const value = storage();
      await expect(
        value.publishDerivative(key, new Uint8Array(size)),
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it("drains a late Node body's actual asynchronous destroy callback before closing SDK", async () => {
    const value = storage();
    const waiting = deferred<unknown>();
    mocks.send.mockReturnValue(waiting.promise);
    let releaseDestroy: (() => void) | undefined;
    const stream = new Readable({
      read() {},
      destroy(error, callback) {
        releaseDestroy = () => callback(error);
      },
    });
    const abort = new AbortController();
    let readSettled = false;
    let closeSettled = false;
    const result = value
      .readDerivative(key, etag, bytes.length, abort.signal)
      .catch((error) => error)
      .finally(() => {
        readSettled = true;
      });
    abort.abort();
    waiting.resolve({ ...head(), Body: stream });
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    const closing = value.close().then(() => {
      closeSettled = true;
    });
    try {
      await Promise.resolve();
      expect(releaseDestroy).toBeTypeOf("function");
      expect(readSettled).toBe(false);
      expect(closeSettled).toBe(false);
      expect(mocks.destroy).not.toHaveBeenCalled();
    } finally {
      releaseDestroy?.();
    }
    expect(await result).toMatchObject({ status: 503 });
    await closing;
    expect(stream.closed).toBe(true);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("keeps a successful Node read owned through delayed native close", async () => {
    const value = storage();
    let releaseDestroy: (() => void) | undefined;
    const stream = new Readable({
      read() {
        this.push(bytes);
        this.push(null);
      },
      destroy(error, callback) {
        releaseDestroy = () => callback(error);
      },
    });
    mocks.send.mockResolvedValueOnce({ ...head(), Body: stream });
    let settled = false;
    const result = value.readDerivative(key, etag, bytes.length).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(releaseDestroy).toBeTypeOf("function"));
    try {
      expect(settled).toBe(false);
      expect(stream.closed).toBe(false);
    } finally {
      releaseDestroy?.();
    }
    await expect(result).resolves.toEqual(bytes);
    expect(stream.closed).toBe(true);
  });
});
