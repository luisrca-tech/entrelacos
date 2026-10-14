import {
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryPageResponseSchema,
} from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGiftPaymentHistoryHttpRouter } from "../../../api/src/giftPaymentHistoryHttp";
import { apiRequest } from "../lib/apiClient";
import { proxyApiRequest } from "./apiProxy";

const config = {
  apiBaseUrl: "https://api.example.test",
  adminOrigin: "https://admin.example.test",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function proxyRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://admin.example.test${path}`, {
    ...init,
    headers: {
      Origin: config.adminOrigin,
      ...(init.headers ?? {}),
    },
  });
}

describe("admin API proxy", () => {
  it.each([
    "application/json",
    "application/problem+json",
    "application/octet-stream",
  ])(
    "owns actual media response %s through abort and cancellation settlement",
    async (type) => {
      const pull = vi.fn();
      let release!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = vi.fn(() => cancellation);
      let responseController!: ReadableStreamDefaultController<Uint8Array>;
      const responseBody = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            responseController = controller;
          },
          pull,
          cancel,
        },
        { highWaterMark: 0 },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(responseBody, {
              status: 200,
              headers: { "Content-Type": type },
            }),
        ),
      );
      const abort = new AbortController();
      const first = proxyApiRequest(
        binaryRequest(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          {},
          abort.signal,
        ),
        config,
      );
      void first.catch(() => {});
      try {
        await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce(), {
          timeout: 100,
        });
        abort.abort();
        await Promise.resolve();
        expect(cancel).toHaveBeenCalledOnce();
        expect(
          (
            await proxyApiRequest(
              binaryRequest(new ReadableStream({}, { highWaterMark: 0 })),
              config,
            )
          ).status,
        ).toBe(409);
      } finally {
        release();
        if (!cancel.mock.calls.length)
          responseController.error(new Error("Test cleanup"));
        if (!responseBody.locked) await responseBody.cancel().catch(() => {});
      }
      expect((await first).status).toBe(502);
      expect(responseBody.locked).toBe(false);
    },
  );
  it("retains the media response reader under the 45-second operation deadline", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    let responseController!: ReadableStreamDefaultController<Uint8Array>;
    const responseBody = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          responseController = controller;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(responseBody, {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const first = proxyApiRequest(
      binaryRequest(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      ),
      config,
    );
    void first.catch(() => {});
    await vi.advanceTimersByTimeAsync(45_000);
    try {
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        (
          await proxyApiRequest(
            binaryRequest(new ReadableStream({}, { highWaterMark: 0 })),
            config,
          )
        ).status,
      ).toBe(409);
    } finally {
      release();
      if (!cancel.mock.calls.length)
        responseController.error(new Error("Test cleanup"));
    }
    expect((await first).status).toBe(502);
  });
  const binaryPath = "/api/v1/sites/site-a/gift-media/asset-a/finalize";
  it.each(["abort", "deadline"])(
    "keeps cancellation settlement under caller %s ownership",
    async (boundary) => {
      vi.useFakeTimers();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = new ReadableStream<Uint8Array>(
        {
          cancel() {
            entered();
            return waiting;
          },
        },
        { highWaterMark: 0 },
      );
      let signal!: AbortSignal;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          signal = init.signal;
          return new Response("denied", { status: 401 });
        }),
      );
      const abort = new AbortController();
      const first = proxyApiRequest(
        binaryRequest(source, {}, abort.signal),
        config,
      );
      await started;
      await vi.advanceTimersByTimeAsync(0);
      try {
        if (boundary === "abort") abort.abort();
        else await vi.advanceTimersByTimeAsync(45_000);
        expect(signal.aborted).toBe(true);
        expect(
          (
            await proxyApiRequest(
              binaryRequest(new ReadableStream({}, { highWaterMark: 0 })),
              config,
            )
          ).status,
        ).toBe(409);
      } finally {
        release();
      }
      expect((await first).status).toBe(502);
    },
  );
  it("seals the forwarded request stream on early response before releasing its original reader", async () => {
    const pull = vi.fn();
    let forwarded!: ReadableStream<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        forwarded = init.body;
        return new Response("denied", { status: 401 });
      }),
    );
    expect(
      (
        await proxyApiRequest(
          binaryRequest(
            new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
          ),
          config,
        )
      ).status,
    ).toBe(401);
    const reader = forwarded.getReader();
    try {
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      reader.releaseLock();
    }
    expect(pull).not.toHaveBeenCalled();
  });
  function binaryRequest(
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return proxyRequest(binaryPath, {
      method: "POST",
      body,
      headers: { "Content-Type": "image/png", ...headers },
      signal,
      ...{ duplex: "half" },
    });
  }
  it("dispatches a fixed-target binary stream without buffering and cancels on an early upstream denial", async () => {
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    );
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    );
    const upstream = vi.fn(async (_url, init) => {
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.duplex).toBe("half");
      expect(pull).not.toHaveBeenCalled();
      return new Response("denied", { status: 401 });
    });
    vi.stubGlobal("fetch", upstream);
    expect((await proxyApiRequest(binaryRequest(source), config)).status).toBe(
      401,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
    expect(upstream.mock.calls[0][0]).toBe(
      "https://api.example.test/v1/sites/site-a/gift-media/asset-a/finalize",
    );
  });
  it("forwards exact bytes and a validated content length without hostile headers", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const upstream = vi.fn(async (_url, init) => {
      expect(
        new Uint8Array(await new Response(init.body).arrayBuffer()),
      ).toEqual(new Uint8Array([1, 2]));
      expect(Object.fromEntries(new Headers(init.headers))).toEqual({
        "content-type": "image/png",
        "content-length": "2",
        cookie: "opaque",
        origin: config.adminOrigin,
      });
      return new Response("ok");
    });
    vi.stubGlobal("fetch", upstream);
    expect(
      (
        await proxyApiRequest(
          binaryRequest(source, {
            "Content-Length": "2",
            Cookie: "opaque",
            Authorization: "hostile",
            "X-Storage-Key": "private",
          }),
          config,
        )
      ).status,
    ).toBe(200);
  });
  it.each(["0", "-1", "5242881", "1.2", "2bad"])(
    "denies binary Content-Length %s before fetch or source pull",
    async (length) => {
      const pull = vi.fn(
        (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      );
      const upstream = vi.fn(async () => new Response("unexpected"));
      vi.stubGlobal("fetch", upstream);
      expect(
        (
          await proxyApiRequest(
            binaryRequest(new ReadableStream({ pull }, { highWaterMark: 0 }), {
              "Content-Length": length,
            }),
            config,
          )
        ).status,
      ).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
    },
  );
  it("bounds actual bytes even without Content-Length and cancels the original source", async () => {
    const cancel = vi.fn();
    let sent = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) controller.close();
          else {
            sent = true;
            controller.enqueue(new Uint8Array(5_242_881));
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        await new Response(init.body).arrayBuffer();
        return new Response("impossible");
      }),
    );
    expect((await proxyApiRequest(binaryRequest(source), config)).status).toBe(
      502,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
  it("keeps admission until original early-denial cancellation actually settles", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const source = new ReadableStream<Uint8Array>(
      {
        cancel() {
          entered();
          return waiting;
        },
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    const first = proxyApiRequest(binaryRequest(source), config);
    await started;
    try {
      expect(
        (
          await proxyApiRequest(
            binaryRequest(new ReadableStream({}, { highWaterMark: 0 })),
            config,
          )
        ).status,
      ).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(403);
  });
  it("propagates request abort and waits for real upstream settlement", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        signal = init.signal;
        entered();
        await waiting;
        throw new Error("aborted");
      }),
    );
    const abort = new AbortController();
    let settled = false;
    const first = proxyApiRequest(
      binaryRequest(
        new ReadableStream(
          {
            start(controller) {
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        {},
        abort.signal,
      ),
      config,
    ).then((response) => {
      settled = true;
      return response;
    });
    await started;
    abort.abort();
    await Promise.resolve();
    try {
      expect(signal.aborted).toBe(true);
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect((await first).status).toBe(502);
  });
  it("cancels a stalled body at its deadline and retains admission until fetch really settles", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn();
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        signal = init.signal;
        entered();
        await waiting;
        return new Response("late");
      }),
    );
    const first = proxyApiRequest(
      binaryRequest(new ReadableStream({ cancel }, { highWaterMark: 0 })),
      config,
    );
    await started;
    await vi.advanceTimersByTimeAsync(15_000);
    try {
      expect(signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        (
          await proxyApiRequest(
            binaryRequest(new ReadableStream({}, { highWaterMark: 0 })),
            config,
          )
        ).status,
      ).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(502);
  });
  it("also bounds JSON media requests and rejects encoded media bodies", async () => {
    const upstream = vi.fn(async (_url, init) => {
      await new Response(init.body).arrayBuffer();
      return new Response("unexpected");
    });
    vi.stubGlobal("fetch", upstream);
    const response = await proxyApiRequest(
      proxyRequest(binaryPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: " ".repeat(16_385),
      }),
      config,
    );
    expect(response.status).toBe(502);
    const calls = upstream.mock.calls.length;
    expect(
      (
        await proxyApiRequest(
          binaryRequest(new ReadableStream({}, { highWaterMark: 0 }), {
            "Content-Encoding": "gzip",
          }),
          config,
        )
      ).status,
    ).toBe(400);
    expect(upstream.mock.calls).toHaveLength(calls);
  });
  it("forwards only the fixed API path and safe request headers", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "better-auth.session_token=opaque; Path=/; HttpOnly",
          "X-Request-Id": "request-id",
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=opaque",
          "Content-Type": "application/json",
          "X-Forwarded-Host": "evil.example.test",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "secret",
        }),
      }),
      config,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=opaque",
    );
    expect(response.headers.get("x-request-id")).toBe("request-id");
    expect(await response.json()).toEqual({ ok: true });
    const [target, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("https://api.example.test/v1/auth/sign-in/email");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      cookie: "better-auth.session_token=opaque",
      "content-type": "application/json",
      origin: config.adminOrigin,
    });
  });

  it("allows same-origin GET without Origin and preserves its query", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me?tab=summary"),
      config,
    );

    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v1/me?tab=summary",
    );
  });

  it("preserves attachment metadata and binary report bytes", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="entrelacos-convites-casamento.csv"',
          },
        }),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/sites/casamento-a/reports/invitations.csv"),
      config,
    );

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="entrelacos-convites-casamento.csv"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects foreign Origin and cross-site fetch metadata for safe reads", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const foreignOrigin = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me", {
        headers: { Origin: "https://evil.example.test" },
      }),
      config,
    );
    const crossSite = await proxyApiRequest(
      new Request("https://admin.example.test/api/v1/me", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      config,
    );

    expect(foreignOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects hostile origins, traversal, and open-proxy paths without fetching", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const hostile = await proxyApiRequest(
      proxyRequest("/api/v1/me", {
        headers: { Origin: "https://evil.example.test" },
      }),
      config,
    );
    expect(hostile.status).toBe(403);

    const traversal = await proxyApiRequest(
      proxyRequest("/api/v1/%2e%2e%2fsecret"),
      config,
    );
    expect(traversal.status).toBe(404);

    const openProxy = await proxyApiRequest(
      proxyRequest("/api/https://evil.example.test"),
      config,
    );
    expect(openProxy.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("removes tokens from native auth JSON while leaving safe /me session metadata intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            token: "secret",
            session: { token: "secret-2", id: "safe-id" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/sign-in/email"),
      config,
    );
    expect(await response.json()).toEqual({
      ok: true,
      session: { id: "safe-id" },
    });
  });

  it("preserves intentional tokens on non-native auth paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, token: "one-time-link" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await proxyApiRequest(
      proxyRequest("/api/v1/auth/activate"),
      config,
    );
    expect(await response.json()).toEqual({
      ok: true,
      token: "one-time-link",
    });
  });
});

const historyPath = "/api/v1/sites/site-a/finance/purchases";
function historyProblem(status: number) {
  return {
    type: "about:blank",
    title: "private upstream diagnostic",
    status,
    code: "PRIVATE_CODE",
  };
}
function upstreamJson(value: unknown = { ok: true }, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public" },
  });
}
describe("history proxy transport", () => {
  it("rejects raw history POST before pulling its deferred body or fetching", async () => {
    const fetcher = vi.fn(async () => upstreamJson());
    vi.stubGlobal("fetch", fetcher);
    const pull = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull,
      },
      { highWaterMark: 0 },
    );
    const request = proxyRequest(historyPath, {
      method: "POST",
      body,
      ...{ duplex: "half" },
    });
    const work = proxyApiRequest(request, config);
    void work.catch(() => {});
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(pull).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      const reply = await work;
      expect(reply.status).toBe(405);
      expect(reply.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      controller.close();
      await work;
    }
  });
  it.each([
    "/api/v1/sites/bad:site/finance/purchases",
    "/api/v1/sites//finance/purchases",
    "/api/v1/sites/%73ite-a/finance/purchases",
    `${historyPath}/order-a/wrong`,
    `${historyPath}/order-a/history/child`,
    `${historyPath}?cursor=`,
    `${historyPath}?cursor=one&cursor=two`,
    `${historyPath}?mode=live`,
    `${historyPath}?cursor=bad%252E`,
    `${historyPath}?cursor=${"a".repeat(257)}`,
  ])("rejects reserved-family invalidity locally: %s", async (path) => {
    const fetcher = vi.fn(async () => upstreamJson());
    vi.stubGlobal("fetch", fetcher);
    const reply = await proxyApiRequest(proxyRequest(path), config);
    expect([400, 404]).toContain(reply.status);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["order:a..b", "order..b", "order.a", "order:a", "order-a"])(
    "forwards the exact canonical original identity %s",
    async (original) => {
      const fetcher = vi.fn(async () => upstreamJson());
      vi.stubGlobal("fetch", fetcher);
      const encoded = encodeURIComponent(original).replaceAll(".", "%2E");
      const reply = await proxyApiRequest(
        proxyRequest(`${historyPath}/${encoded}/history`, {
          headers: {
            Cookie: "session=synthetic",
            Authorization: "discard",
            "X-Forwarded-Host": "foreign.example.test",
          },
        }),
        config,
      );
      expect(reply.status).toBe(200);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(fetcher).toHaveBeenCalledWith(
        "https://api.example.test/v1/sites/site-a/finance/purchases/" +
          encoded +
          "/history",
        expect.objectContaining({
          method: "GET",
          redirect: "manual",
          signal: expect.any(AbortSignal),
        }),
      );
      const headers = new Headers(
        (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
      );
      expect(Object.fromEntries(headers)).toEqual({
        cookie: "session=synthetic",
        origin: config.adminOrigin,
      });
    },
  );
  it.each([
    "order%3afoo",
    "order%2e%2Efoo",
    "%6Frder-a",
    "order%253Afoo",
    "order%2Ffoo",
    "order%5Cfoo",
    "order%25foo",
    "order%ZZfoo",
  ])("denies noncanonical/unsafe original encoding %s", async (original) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (
        await proxyApiRequest(
          proxyRequest(`${historyPath}/${original}/history`),
          config,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    { "Content-Length": "1" },
    { "Content-Length": "00" },
    { "Transfer-Encoding": "chunked" },
  ])("denies invalid request framing without fetch", async (headers) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await proxyApiRequest(proxyRequest(historyPath, { headers }), config))
        .status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps safe raw originals and opaque query values while rejecting foreign encoded resources", async () => {
    const fetcher = vi.fn(async () => upstreamJson());
    vi.stubGlobal("fetch", fetcher);
    expect(
      (
        await proxyApiRequest(
          proxyRequest(
            `${historyPath}/order.a/history?cursor=gh1%2E%2Eopaque%3Anext`,
          ),
          config,
        )
      ).status,
    ).toBe(200);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toContain(
      "?cursor=gh1%2E%2Eopaque%3Anext",
    );
    expect(
      (
        await proxyApiRequest(
          proxyRequest("/api/v1/sites/site-a/gift-media/asset%3Afoo/finalize", {
            method: "POST",
          }),
          config,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([200, 401, 403, 503])(
    "bounds streamed status%s bytes even when Content-Length lies",
    async (status) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          start(c) {
            c.enqueue(new TextEncoder().encode("á".repeat(65537)));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status,
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "1",
              },
            }),
        ),
      );
      const reply = await proxyApiRequest(proxyRequest(historyPath), config);
      expect(reply.status).toBe(502);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(await reply.text()).not.toContain("á");
    },
  );
  it("accepts131072 actual UTF-8 bytes and rejects byte131073 without text()/arrayBuffer()", async () => {
    const json = JSON.stringify({ ok: true });
    let text = json + " ".repeat(131072 - json.length);
    const fetcher = vi.fn(async () => {
      const response = new Response(text, {
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperties(response, {
        text: {
          value: () => {
            throw new Error("unbounded text called");
          },
        },
        arrayBuffer: {
          value: () => {
            throw new Error("unbounded buffer called");
          },
        },
      });
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const allowed = await proxyApiRequest(proxyRequest(historyPath), config);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });
    text += " ";
    expect(
      (await proxyApiRequest(proxyRequest(historyPath), config)).status,
    ).toBe(502);
  });
  it("rejects malformed UTF-8 and unsupported/non-JSON error bodies with fixed sanitization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([255]), {
            status: 403,
            headers: { "Content-Type": "application/problem+json" },
          }),
      ),
    );
    expect(
      (await proxyApiRequest(proxyRequest(historyPath), config)).status,
    ).toBe(502);
  });
  it.each([401, 403, 503])(
    "preserves only an owned valid denial%s without private diagnostics",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => upstreamJson(historyProblem(status), status)),
      );
      const reply = await proxyApiRequest(proxyRequest(historyPath), config);
      expect(reply.status).toBe(status);
      expect(await reply.text()).not.toMatch(/private upstream|PRIVATE_CODE/);
      expect(reply.headers.get("cache-control")).toBe("no-store");
    },
  );
  it("returns a bodyless authorized HEAD and rejects oversized unexpected HEAD bodies", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const allowed = await proxyApiRequest(
      proxyRequest(historyPath, { method: "HEAD" }),
      config,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBeNull();
    fetcher.mockResolvedValueOnce(
      new Response("a".repeat(131073), { status: 200 }),
    );
    const denied = await proxyApiRequest(
      proxyRequest(historyPath, { method: "HEAD" }),
      config,
    );
    expect(denied.status).toBe(502);
    expect(denied.body).toBeNull();
  });
  it("does not dispatch a pre-aborted history read", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const reply = await proxyApiRequest(
      proxyRequest(historyPath, { signal: abort.signal }),
      config,
    );
    expect(reply.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline"])(
    "keeps actual pending fetch ownership through %s and cancels its late body",
    async (boundary) => {
      if (boundary === "deadline") vi.useFakeTimers();
      const abort = new AbortController();
      let resolveFetch!: (value: Response) => void;
      let signal: AbortSignal | null | undefined;
      const fetcher = vi.fn<typeof fetch>((_input, init) => {
        signal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const work = proxyApiRequest(
        proxyRequest(historyPath, { signal: abort.signal }),
        config,
      );
      const settled = vi.fn();
      void work.then(settled);
      await Promise.resolve();
      try {
        if (boundary === "abort") abort.abort();
        else await vi.advanceTimersByTimeAsync(45000);
        expect(signal?.aborted).toBe(true);
        expect(settled).not.toHaveBeenCalled();
      } finally {
        resolveFetch(upstreamJson());
        await work;
      }
      expect((await work).status).toBe(502);
    },
  );
  it.each(["abort", "deadline"])(
    "waits real pending reader and cancellation after %s",
    async (boundary) => {
      if (boundary === "deadline") vi.useFakeTimers();
      const abort = new AbortController();
      let release!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = vi.fn(() => cancellation);
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          start(c) {
            source = c;
          },
          pull,
          cancel,
        },
        { highWaterMark: 0 },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      const work = proxyApiRequest(
        proxyRequest(historyPath, { signal: abort.signal }),
        config,
      );
      const settled = vi.fn();
      void work.then(settled);
      try {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(pull).toHaveBeenCalled();
        if (boundary === "abort") abort.abort();
        else await vi.advanceTimersByTimeAsync(45000);
        await Promise.resolve();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(settled).not.toHaveBeenCalled();
        expect(body.locked).toBe(true);
      } finally {
        release();
        if (!cancel.mock.calls.length) {
          source.enqueue(new TextEncoder().encode("{}"));
          source.close();
        }
        await work;
      }
      expect((await work).status).toBe(502);
      expect(body.locked).toBe(false);
    },
  );
  it("retains a late acquired body's cancellation promise after request abort", async () => {
    const abort = new AbortController();
    let resolveFetch!: (value: Response) => void, release!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          source = c;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const work = proxyApiRequest(
      proxyRequest(historyPath, { signal: abort.signal }),
      config,
    );
    const settled = vi.fn();
    void work.then(settled);
    abort.abort();
    resolveFetch(
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(body.locked).toBe(true);
    } finally {
      release?.();
      if (!cancel.mock.calls.length) {
        source.enqueue(new TextEncoder().encode("{}"));
        source.close();
      }
      await work;
    }
    expect((await work).status).toBe(502);
    expect(body.locked).toBe(false);
  });
});

describe("history proxy integration and denial bounds", () => {
  it("preserves canonical originals through frozen apiRequest and accepted HTTP GET/HEAD", async () => {
    const original = {
      siteId: "site-a",
      mode: "sandbox" as const,
      orderId: "order:a..b",
      quoteId: "quote-a",
      giftId: "gift-a",
      titleSnapshot: "Original purchase",
      method: "PIX" as const,
      currency: "BRL" as const,
      purchasedAtMicros: "100",
      destinationVersion: 1,
      policyVersion: "policy-a",
      binding: "AVAILABLE" as const,
      quoted: {
        nominalCents: 1000,
        commissionCents: 100,
        processingCents: 0,
        totalCents: 1100,
      },
    };
    const envelope = {
      scope: {
        siteId: "site-a",
        mode: "sandbox" as const,
        policy: "SITE_HISTORY" as const,
      },
      consistency: "PER_READ" as const,
      readObservedAtMicros: "10000",
      currentKnowledge: "UNKNOWN" as const,
      sourceOrdering: "UNAVAILABLE" as const,
      nextCursor: null,
    };
    const page = { history: { ...envelope, items: [original] } };
    const detail = {
      history: {
        ...envelope,
        originalPurchase: original,
        coverage: {
          payments: "AVAILABLE" as const,
          receipts: "AVAILABLE" as const,
          reversals: "UNAVAILABLE" as const,
          bankSettlement: "UNAVAILABLE" as const,
        },
        retainedPayments: [],
        validatedHistoricalReceipts: [],
      },
    };
    const inputs: Array<{
      siteId: string;
      orderId?: string;
      request: Request;
    }> = [];
    const router = createGiftPaymentHistoryHttpRouter({
      adminOrigin: config.adminOrigin,
      giftPaymentHistory: {
        available: true,
        readPurchasePage(input) {
          inputs.push(input);
          return {
            result: Promise.resolve(page),
            completion: Promise.resolve(),
            cancel() {},
          };
        },
        readPurchaseDetailPage(input) {
          inputs.push(input);
          return {
            result: Promise.resolve(detail),
            completion: Promise.resolve(),
            cancel() {},
          };
        },
        async close() {},
      },
    });
    const carrier: typeof fetch = async (input, init) => {
      const request = new Request(
        new URL(String(input), config.adminOrigin),
        init,
      );
      return new URL(request.url).origin === config.adminOrigin
        ? proxyApiRequest(request, config)
        : router.fetch(request);
    };
    vi.stubGlobal("fetch", carrier);
    try {
      const listed = giftPurchaseHistoryPageResponseSchema.parse(
        await apiRequest("/v1/sites/site-a/finance/purchases"),
      );
      expect(listed.history.items).toEqual([original]);
      const encoded = encodeURIComponent(original.orderId).replaceAll(
        ".",
        "%2E",
      );
      const path = `/v1/sites/site-a/finance/purchases/${encoded}/history`;
      const observed = giftPurchaseHistoryDetailResponseSchema.parse(
        await apiRequest(path),
      );
      expect(observed.history.originalPurchase).toEqual(original);
      const head = await proxyApiRequest(
        proxyRequest(`/api${path}`, { method: "HEAD" }),
        config,
      );
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
      expect(
        inputs.map(({ siteId, orderId, request }) => [
          siteId,
          orderId,
          request.headers.get("origin"),
        ]),
      ).toEqual([
        ["site-a", undefined, config.adminOrigin],
        ["site-a", original.orderId, config.adminOrigin],
        ["site-a", original.orderId, config.adminOrigin],
      ]);
    } finally {
      await router.close();
    }
  });
  it.each([
    "application/problem+json",
    "text/plain",
    "application/octet-stream",
  ])("bounds oversized error bodies before MIME handling: %s", async (type) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(131073));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 401,
            headers: { "Content-Type": type, "Content-Length": "1" },
          }),
      ),
    );
    const reply = await proxyApiRequest(proxyRequest(historyPath), config);
    expect(reply.status).toBe(502);
    expect(await reply.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it.each([200, 401, 403])(
    "sanitizes malformed JSON without inventing authority loss: %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response('{"private":', {
              status,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      const reply = await proxyApiRequest(proxyRequest(historyPath), config);
      expect(reply.status).toBe(502);
      expect(await reply.text()).not.toContain("private");
    },
  );
  it("rejects a mismatched problem status and non-JSON success", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(upstreamJson(historyProblem(403), 401))
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "Content-Type": "text/plain" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await proxyApiRequest(proxyRequest(historyPath), config)).status,
      ).toBe(502);
    }
  });
  it.each(["PUT", "PATCH", "DELETE", "OPTIONS"])(
    "denies history %s without upstream dispatch",
    async (method) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const reply = await proxyApiRequest(
        proxyRequest(historyPath, { method, body: "private" }),
        config,
      );
      expect(reply.status).toBe(405);
      expect(reply.headers.get("allow")).toBe("GET, HEAD");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("captures trusted configuration before a pending fetch", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const options = { ...config };
    const work = proxyApiRequest(
      proxyRequest(historyPath, { headers: { Cookie: "session=synthetic" } }),
      options,
    );
    options.adminOrigin = "https://foreign.example.test";
    options.apiBaseUrl = "https://foreign.example.test";
    resolve(upstreamJson());
    const reply = await work;
    expect(reply.status).toBe(200);
    const [target, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(
      "https://api.example.test/v1/sites/site-a/finance/purchases",
    );
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      cookie: "session=synthetic",
      origin: config.adminOrigin,
    });
  });
  it("removes abort ownership and releases its lock only after actual cancellation", async () => {
    const abort = new AbortController();
    let release!: () => void;
    const cancellation = new Promise<void>((done) => {
      release = done;
    });
    const cancel = vi.fn(() => cancellation);
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const request = proxyRequest(historyPath, { signal: abort.signal });
    const remove = vi.spyOn(request.signal, "removeEventListener");
    const work = proxyApiRequest(request, config);
    void work.catch(() => {});
    try {
      await Promise.resolve();
      await Promise.resolve();
      abort.abort();
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      expect(body.locked).toBe(true);
      release();
      expect((await work).status).toBe(502);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(body.locked).toBe(false);
    } finally {
      release();
      await work;
      remove.mockRestore();
    }
  });
});

describe("history proxy boundary semantics", () => {
  it("accepts an exact131072-byte owned denial and rejects byte131073", async () => {
    const json = JSON.stringify(historyProblem(401));
    let text =
      json + " ".repeat(131072 - new TextEncoder().encode(json).byteLength);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(text, {
            status: 401,
            headers: { "Content-Type": "application/problem+json" },
          }),
      ),
    );
    expect(
      (await proxyApiRequest(proxyRequest(historyPath), config)).status,
    ).toBe(401);
    text += " ";
    const reply = await proxyApiRequest(proxyRequest(historyPath), config);
    expect(reply.status).toBe(502);
    expect(await reply.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
  it.each(["GET", "HEAD"])(
    "rejects malformed successful UTF-8 for %s",
    async (method) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new Uint8Array([255]), {
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
      const reply = await proxyApiRequest(
        proxyRequest(historyPath, { method }),
        config,
      );
      expect(reply.status).toBe(502);
      if (method === "HEAD") expect(reply.body).toBeNull();
    },
  );
  it.each([
    { Origin: "https://foreign.example.test" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[])(
    "enforces common origin protection before history dispatch",
    async (headers) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(
        (await proxyApiRequest(proxyRequest(historyPath, { headers }), config))
          .status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects a foreign request URL and trusted API target normalization drift", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (
        await proxyApiRequest(
          new Request(`https://foreign.example.test${historyPath}`),
          config,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await proxyApiRequest(proxyRequest(historyPath), {
          ...config,
          apiBaseUrl: "https://api.example.test/private",
        })
      ).status,
    ).toBe(500);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
