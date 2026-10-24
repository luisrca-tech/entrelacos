import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  reader: vi.fn(),
  recover: vi.fn(),
  issue: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock("./authHttp", async (original) => ({
  ...(await original<typeof import("./authHttp")>()),
  requireAdminSession: mocks.actor,
  readAdministrativeSession: mocks.reader,
}));
vi.mock("./giftMedia", async (original) => ({
  ...(await original<typeof import("./giftMedia")>()),
  issueGiftMediaUpload: mocks.issue,
  finalizeGiftMediaUpload: vi.fn(),
  consultGiftMediaUpload: mocks.finalize,
  recoverGiftMediaUpload: mocks.recover,
  GiftMediaServiceError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
    }
  },
}));

import { AdminSessionRequiredError } from "./authHttp";
import {
  createGiftMediaProcessing,
  finalizeGiftMediaUpload,
  GiftMediaServiceError,
} from "./giftMedia";
import { createGiftMediaHttpRouter } from "./giftMediaHttp";

const origin = "https://panel.example.test";
const upload = {
  id: "asset-a",
  expiresAt: "2026-10-12T12:10:00.000Z",
};
const media = {
  id: "asset-a",
  siteId: "wedding-a",
  url: "https://media.example.test/gifts/result.webp",
  contentType: "image/webp" as const,
  byteLength: 20,
  width: 2,
  height: 2,
};
const processors: ReturnType<typeof createGiftMediaProcessing>[] = [];
const status = {
  siteId: media.siteId,
  assetId: media.id,
  state: "PENDING",
  expiresAt: upload.expiresAt,
  canRetrySameBytes: true,
  media: null,
};
afterEach(async () => {
  await Promise.all(processors.splice(0).map((value) => value.close()));
  vi.useRealTimers();
});
const router = () => {
  const processing = createGiftMediaProcessing();
  processors.push(processing);
  return createGiftMediaHttpRouter({
    processing,
    db: {} as never,
    auth: {} as never,
    adminOrigin: origin,
  });
};
const request = (path: string, body: unknown, requestOrigin = origin) =>
  new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const rawRequest = (
  path: string,
  body: BodyInit,
  contentType = "application/json",
) =>
  new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": contentType },
    body,
    ...{ duplex: "half" },
  });
const endpoints = [
  {
    label: "upload",
    path: "/v1/sites/wedding-a/gift-media/uploads",
    body: JSON.stringify({
      contentType: "image/png",
      byteLength: 20,
      contentSha256: "a".repeat(64),
    }),
    successStatus: 201,
  },
  {
    label: "finalize",
    path: "/v1/sites/wedding-a/gift-media/asset-a/finalize",
    body: "{}",
    successStatus: 200,
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({
    user: { id: "admin-a", role: "SITE_ASSISTANT" },
    session: { id: "session-a" },
  });
  mocks.reader.mockImplementation(() => mocks.actor());
  mocks.issue.mockResolvedValue({ upload });
  mocks.finalize.mockResolvedValue({ status });
  mocks.recover.mockResolvedValue({ status });
  vi.mocked(finalizeGiftMediaUpload).mockResolvedValue({ media });
});
describe("gift media HTTP boundary", () => {
  it("rejects an empty Content-Encoding header before taking the metadata reader", async () => {
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              contentType: "image/png",
              byteLength: 20,
              contentSha256: "a".repeat(64),
            }),
          ),
        );
        controller.close();
      },
    );
    const req = rawRequest(
      "/v1/sites/wedding-a/gift-media/uploads",
      new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
    );
    req.headers.set("Content-Encoding", "");
    expect((await router().request(req)).status).toBe(400);
    expect(pull).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("forwards the binary reader and the same owner, then rechecks the original native session inside the supplied transaction", async () => {
    const processing = createGiftMediaProcessing();
    processors.push(processing);
    const db = {};
    const selected = createGiftMediaHttpRouter({
      db: db as never,
      auth: {} as never,
      adminOrigin: origin,
      processing,
    });
    const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const response = await selected.request(
      rawRequest(
        "/v1/sites/wedding-a/gift-media/asset-a/finalize",
        body,
        "image/png",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ media });
    const args = vi.mocked(finalizeGiftMediaUpload).mock.calls[0];
    expect(args[4]).toMatchObject({
      body,
      contentType: "image/png",
      signal: expect.any(AbortSignal),
    });
    expect(args[5]?.processing).toBe(processing);
    const tx = {};
    await expect(args[5]?.authorize?.(tx as never)).resolves.toEqual({
      userId: "admin-a",
      role: "SITE_ASSISTANT",
    });
    expect(mocks.reader).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({ db: tx }),
    );
    mocks.reader.mockResolvedValueOnce({
      user: { id: "admin-a", role: "SITE_ASSISTANT" },
      session: { id: "replacement" },
    });
    await expect(args[5]?.authorize?.(tx as never)).rejects.toBeInstanceOf(
      AdminSessionRequiredError,
    );
  });
  it("uses explicit RECOVER and enforces the correlated status envelope", async () => {
    const response = await router().request(
      request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {
        action: "RECOVER",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.finalize).not.toHaveBeenCalled();
    mocks.recover.mockResolvedValueOnce({
      status: { ...status, assetId: "other" },
    });
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {
            action: "RECOVER",
          }),
        )
      ).status,
    ).toBe(503);
  });
  it.each([
    "image/pngBAD",
    "image/png; charset=utf-8",
    "multipart/form-data",
    "image/svg+xml",
  ])("rejects unsupported binary type %s without pulling", async (type) => {
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      { pull },
      { highWaterMark: 0 },
    );
    expect(
      (
        await router().request(
          rawRequest(
            "/v1/sites/wedding-a/gift-media/asset-a/finalize",
            stream,
            type,
          ),
        )
      ).status,
    ).toBe(400);
    expect(pull).not.toHaveBeenCalled();
    expect(finalizeGiftMediaUpload).not.toHaveBeenCalled();
  });
  it("denies native authentication before taking the application binary reader", async () => {
    mocks.actor.mockRejectedValueOnce(new AdminSessionRequiredError());
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      { pull },
      { highWaterMark: 0 },
    );
    expect(
      (
        await router().request(
          rawRequest(
            "/v1/sites/wedding-a/gift-media/asset-a/finalize",
            stream,
            "image/png",
          ),
        )
      ).status,
    ).toBe(401);
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
  it.each(["-1", "0", "5242881", "2.5", "20garbage"])(
    "rejects binary Content-Length %s without service dispatch",
    async (length) => {
      const req = rawRequest(
        "/v1/sites/wedding-a/gift-media/asset-a/finalize",
        new Uint8Array([1]),
        "image/png",
      );
      req.headers.set("Content-Length", length);
      expect((await router().request(req)).status).toBe(400);
      expect(finalizeGiftMediaUpload).not.toHaveBeenCalled();
    },
  );
  it("holds initial native lookup through shutdown and denies body reading afterward", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.actor.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const processing = createGiftMediaProcessing();
    processors.push(processing);
    const selected = createGiftMediaHttpRouter({
      db: {} as never,
      auth: {} as never,
      adminOrigin: origin,
      processing,
    });
    const result = selected.request(
      request("/v1/sites/wedding-a/gift-media/uploads", {}),
    );
    await waiting;
    let closed = false;
    const closing = processing.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release({
      user: { id: "admin-a", role: "SITE_ASSISTANT" },
      session: { id: "session-a" },
    });
    expect((await result).status).toBe(503);
    await closing;
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("holds actual JSON reader cancellation through shutdown", async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered();
        },
        cancel() {
          return cancelled;
        },
      },
      { highWaterMark: 0 },
    );
    const processing = createGiftMediaProcessing();
    processors.push(processing);
    const selected = createGiftMediaHttpRouter({
      db: {} as never,
      auth: {} as never,
      adminOrigin: origin,
      processing,
    });
    const result = selected.request(
      rawRequest("/v1/sites/wedding-a/gift-media/uploads", stream),
    );
    await waiting;
    let closed = false;
    const closing = processing.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect((await result).status).toBe(503);
    await closing;
    expect(stream.locked).toBe(false);
  });

  it.each(endpoints)(
    "rejects application/jsonBAD on $label before calling a service",
    async ({ path, body }) => {
      const response = await router().request(
        rawRequest(path, body, "application/jsonBAD"),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
      });
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );
  it.each(endpoints)(
    "rejects valid $label JSON padded beyond 16384 bytes before calling a service",
    async ({ path, body }) => {
      const padded = body + " ".repeat(16_385 - body.length);
      const response = await router().request(rawRequest(path, padded));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
      });
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );
  it.each(endpoints)(
    "accepts valid $label JSON at exactly 16384 bytes",
    async ({ path, body, successStatus }) => {
      const padded = body + " ".repeat(16_384 - body.length);
      const response = await router().request(rawRequest(path, padded));
      expect(response.status).toBe(successStatus);
      expect(
        mocks.issue.mock.calls.length + mocks.finalize.mock.calls.length,
      ).toBe(1);
    },
  );
  it.each(endpoints)(
    "accepts application/json; charset=utf-8 on $label",
    async ({ path, body, successStatus }) => {
      const response = await router().request(
        rawRequest(path, body, "application/json; charset=utf-8"),
      );
      expect(response.status).toBe(successStatus);
    },
  );
  it.each(endpoints)(
    "cancels the $label stream as soon as actual bytes exceed the cap",
    async ({ path, body }) => {
      const cancelled = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.enqueue(new Uint8Array(16_384).fill(32));
          controller.enqueue(new Uint8Array([32]));
          controller.close();
        },
        cancel: cancelled,
      });
      const response = await router().request(rawRequest(path, stream));
      expect(response.status).toBe(400);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );
  it.each(endpoints)(
    "returns sanitized validation failure for invalid UTF-8 on $label",
    async ({ path, body }) => {
      const bytes = new TextEncoder().encode(body);
      const invalid = new Uint8Array(bytes.byteLength + 1);
      invalid.set(bytes);
      invalid[bytes.byteLength] = 0xff;
      const response = await router().request(rawRequest(path, invalid));
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toEqual({
        type: "about:blank",
        status: 400,
        code: "VALIDATION_ERROR",
        title: "Gift image operation unavailable",
      });
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );
  it("uses trusted site actor and strict upload/finalize C1 envelopes", async () => {
    const input = {
      contentType: "image/png",
      byteLength: 20,
      contentSha256: "a".repeat(64),
    };
    const response = await router().request(
      request("/v1/sites/wedding-a/gift-media/uploads", input),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ upload });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.issue).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-a", role: "SITE_ASSISTANT" },
      "wedding-a",
      input,
      expect.anything(),
    );
    const final = await router().request(
      request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {}),
    );
    expect(final.status).toBe(200);
    expect(await final.json()).toEqual({ status });
  });
  it("requires exact origin/session before media services", async () => {
    expect(
      (
        await router().request(
          request(
            "/v1/sites/wedding-a/gift-media/uploads",
            {},
            "https://foreign.test",
          ),
        )
      ).status,
    ).toBe(403);
    mocks.actor.mockRejectedValueOnce(new AdminSessionRequiredError());
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gift-media/uploads", {}),
        )
      ).status,
    ).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("rejects MIME/byte/role/storage overrides and nonempty finalize bodies", async () => {
    for (const body of [
      { contentType: "image/svg+xml", byteLength: 20 },
      { contentType: "image/png", byteLength: 5242881 },
      { contentType: "image/png", byteLength: 20, stagingKey: "private" },
      { contentType: "image/png", byteLength: 20, siteId: "other" },
    ])
      expect(
        (
          await router().request(
            request("/v1/sites/wedding-a/gift-media/uploads", body),
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {
            ready: true,
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it("sanitizes known errors and rejects private or cross-site successful output", async () => {
    mocks.finalize.mockRejectedValueOnce(
      new GiftMediaServiceError(
        409,
        "GIFT_MEDIA_PROCESSING",
        "private-key staging signed-url",
      ),
    );
    const result = await router().request(
      request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {}),
    );
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("private-key");
    mocks.finalize.mockResolvedValueOnce({
      status: { ...status, siteId: "wedding-b" },
    });
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gift-media/asset-a/finalize", {}),
        )
      ).status,
    ).toBe(503);
    mocks.issue.mockResolvedValueOnce({
      upload: { ...upload, secretKey: "private" },
    });
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gift-media/uploads", {
            contentType: "image/png",
            byteLength: 20,
            contentSha256: "a".repeat(64),
          }),
        )
      ).status,
    ).toBe(503);
  });
});

function deliveryFixture() {
  const processing = createGiftMediaProcessing();
  processors.push(processing);
  const bytes = Buffer.from("RIFF0000WEBPpublic-derivative");
  const head = {
    etag: '"immutable-etag"',
    byteLength: bytes.length,
    contentType: "image/webp" as const,
  };
  const storage = {
    storageNamespace: "gifts-existing",
    getDerivativeUrl: vi.fn((key: string) => `https://api.example.test/${key}`),
    headDerivative: vi.fn(async (_key: string, _signal?: AbortSignal) => ({
      ...head,
    })),
    readDerivative: vi.fn(
      async (
        _key: string,
        _etag: string,
        _size: number,
        _signal?: AbortSignal,
      ) => bytes,
    ),
    publishDerivative: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const api = createGiftMediaHttpRouter({
    db: {} as never,
    auth: {} as never,
    adminOrigin: origin,
    processing,
    storage,
  });
  const path = "/gifts/wedding-a/asset-a/processing-a.webp";
  return { api, path, bytes, head, storage, processing };
}

describe("public immutable gift derivative delivery", () => {
  it("serves only the exact derivative without a session, origin, or database read", async () => {
    const f = deliveryFixture();
    const result = await f.api.request(f.path);
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(f.bytes);
    expect(result.headers.get("Content-Type")).toBe("image/webp");
    expect(result.headers.get("Content-Length")).toBe(String(f.bytes.length));
    expect(result.headers.get("ETag")).toBe(f.head.etag);
    expect(result.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(f.storage.headDerivative).toHaveBeenCalledWith(
      f.path.slice(1),
      expect.any(AbortSignal),
    );
    expect(f.storage.readDerivative).toHaveBeenCalledWith(
      f.path.slice(1),
      f.head.etag,
      f.head.byteLength,
      expect.any(AbortSignal),
    );
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("serves HEAD metadata without taking an object body", async () => {
    const f = deliveryFixture();
    const response = await f.api.request(f.path, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Length")).toBe(String(f.bytes.length));
    expect(response.headers.get("ETag")).toBe(f.head.etag);
    expect(f.storage.headDerivative).toHaveBeenCalledOnce();
    expect(f.storage.readDerivative).not.toHaveBeenCalled();
  });
  it.each([
    '"immutable-etag"',
    'W/"immutable-etag"',
    '"another", W/"immutable-etag"',
    "*",
  ])("returns conditional 304 for %s without reading bytes", async (value) => {
    const f = deliveryFixture();
    const response = await f.api.request(f.path, {
      headers: { "If-None-Match": value },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("ETag")).toBe(f.head.etag);
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(f.storage.readDerivative).not.toHaveBeenCalled();
  });
  it.each(['"different"', 'junk"immutable-etag"', '"immutable-etag" trailing'])(
    "ignores unmatched or malformed validator %s",
    async (value) => {
      const f = deliveryFixture();
      const response = await f.api.request(f.path, {
        headers: { "If-None-Match": value },
      });
      expect(response.status).toBe(200);
      expect(f.storage.readDerivative).toHaveBeenCalledOnce();
    },
  );
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "refuses %s without storage access",
    async (method) => {
      const f = deliveryFixture();
      const response = await f.api.request(f.path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(f.storage.headDerivative).not.toHaveBeenCalled();
      expect(f.storage.readDerivative).not.toHaveBeenCalled();
    },
  );
  it.each([
    "/gifts",
    "/gifts/",
    "/gifts/wedding-a/",
    "/gifts/wedding-a/asset-a/processing-a.png",
    "/gifts/wedding-a/asset-a/nested/processing.webp",
    "/gifts/wedding-a/asset-a/processing.webp/extra",
    "/gifts/wedding-a%2Fforeign/asset-a/processing.webp",
    "/gifts/wedding-a/asset%2Fa/processing.webp",
    "/gifts/wedding-a/asset-a/%2e%2e%2fprivate.webp",
    "/gifts/wedding-a/asset-a/%5Cprivate.webp",
    "/gifts/wedding-a/%61sset-a/processing.webp",
    "/gifts/wedding-a/asset-a/processing%00.webp",
  ])(
    "rejects noncanonical or escaped key %s without storage access",
    async (path) => {
      const f = deliveryFixture();
      const response = await f.api.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(f.storage.headDerivative).not.toHaveBeenCalled();
    },
  );
  it.each([
    { contentType: "text/html" },
    { byteLength: 0 },
    { byteLength: 5_242_881 },
    { etag: "unquoted" },
    { etag: '"injected\\etag"' },
  ])("keeps malformed object metadata unavailable %j", async (change) => {
    const f = deliveryFixture();
    f.storage.headDerivative.mockResolvedValueOnce({
      ...f.head,
      ...change,
    } as never);
    const response = await f.api.request(f.path);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.storage.readDerivative).not.toHaveBeenCalled();
  });
  it("rejects a body that differs from verified Content-Length", async () => {
    const f = deliveryFixture();
    f.storage.readDerivative.mockResolvedValueOnce(Buffer.from("wrong-length"));
    const response = await f.api.request(f.path);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("wrong-length");
  });
  it("sanitizes storage errors and never caches an unknown result", async () => {
    const f = deliveryFixture();
    f.storage.headDerivative.mockRejectedValueOnce(
      new Error("secret-account bucket token"),
    );
    const response = await f.api.request(f.path);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/secret-account|bucket|token/);
  });
  it("owns an aborted native body until actual completion and drains it before close", async () => {
    const f = deliveryFixture();
    let release!: (bytes: typeof f.bytes) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    f.storage.readDerivative.mockImplementationOnce(
      (_key, _etag, _size, input) => {
        signal = input;
        entered();
        return new Promise<typeof f.bytes>((resolve) => {
          release = resolve;
        });
      },
    );
    const controller = new AbortController();
    const pending = f.api.request(
      new Request(`https://api.example.test${f.path}`, {
        signal: controller.signal,
      }),
    );
    await started;
    controller.abort();
    let closed = false;
    const closing = f.processing.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    release(f.bytes);
    expect((await pending).status).toBe(503);
    await closing;
    expect(closed).toBe(true);
  });
});

it("bounds public native reads to eight and releases slots only after their actual settlement", async () => {
  const f = deliveryFixture();
  let release!: (value: typeof f.bytes) => void;
  const held = new Promise<typeof f.bytes>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.storage.readDerivative.mockImplementation(async () => {
    if (f.storage.readDerivative.mock.calls.length === 8) started();
    return held;
  });
  const active = Array.from({ length: 8 }, () => f.api.request(f.path));
  await ready;
  const overloaded = f.api.request(f.path);
  try {
    await Promise.resolve();
    expect(f.storage.headDerivative).toHaveBeenCalledTimes(8);
    expect(f.storage.readDerivative).toHaveBeenCalledTimes(8);
  } finally {
    release(f.bytes);
    await Promise.all([...active, overloaded]);
  }
  const response = await overloaded;
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await f.api.request(f.path)).status).toBe(200);
});
it("does not leak public read slots after storage failures", async () => {
  const f = deliveryFixture();
  f.storage.headDerivative.mockRejectedValue(new Error("native failure"));
  for (let attempt = 0; attempt < 9; attempt++)
    expect((await f.api.request(f.path)).status).toBe(503);
  expect(f.storage.headDerivative).toHaveBeenCalledTimes(9);
});
