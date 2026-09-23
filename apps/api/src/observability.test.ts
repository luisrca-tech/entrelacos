import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import {
  createObservabilityMiddleware,
  sanitizeObservabilityEvent,
} from "./observability";

const requestId = "11111111-1111-4111-8111-111111111111";

function forbiddenValue(label: string): string {
  return createHash("sha256").update(`block7-redaction:${label}`).digest("hex");
}

describe("safe observability", () => {
  it("keeps only allowlisted scalar fields and drops nested forbidden values", () => {
    const forbiddenPhone = ["+55", "11", "9", "99999999"].join("");
    const forbiddenPassword = forbiddenValue("password");
    const forbiddenBearer = `Bearer ${forbiddenValue("bearer")}`;
    const forbiddenCookie = `session=${forbiddenValue("cookie")}`;
    const forbiddenPin = ["12", "34", "56"].join("");
    const forbiddenOtp = ["65", "43", "21"].join("");
    const forbidden = {
      password: forbiddenPassword,
      authorization: forbiddenBearer,
      cookie: forbiddenCookie,
      phone: forbiddenPhone,
      email: "guest@example.test",
      name: "Guest Name",
      message: "Private message",
      pin: forbiddenPin,
      otp: forbiddenOtp,
      url: `https://example.test/private?phone=${encodeURIComponent(forbiddenPhone)}`,
      sql: "SELECT * FROM private_table",
      stack: "Error: secret stack",
    };

    const event = sanitizeObservabilityEvent({
      timestamp: "2028-04-01T12:00:00.000Z",
      level: "info",
      event: "http.request",
      requestId,
      routeTemplate: "/v1/sites/:siteId",
      method: "GET",
      status: 200,
      durationMs: 4,
      operation: "request",
      result: "success",
      siteId: "site-demo",
      actorRole: "OWNER",
      mode: "manual",
      rateLimitOutcome: "not_applicable",
      datasetVersion: "block7-demo-v1",
      count: 2,
      errorCode: "NONE",
      body: forbidden,
      nested: { error: forbidden },
      error: { cause: { stack: forbidden.stack, phone: forbidden.phone } },
      response: { body: forbidden.message },
    });

    expect(event).toEqual({
      timestamp: "2028-04-01T12:00:00.000Z",
      level: "info",
      event: "http.request",
      requestId,
      routeTemplate: "/v1/sites/:siteId",
      method: "GET",
      status: 200,
      durationMs: 4,
      operation: "request",
      result: "success",
      siteId: "site-demo",
      actorRole: "OWNER",
      mode: "manual",
      rateLimitOutcome: "not_applicable",
      datasetVersion: "block7-demo-v1",
      count: 2,
      errorCode: "NONE",
    });
    expect(JSON.stringify(event)).not.toContain(forbiddenPassword);
    expect(JSON.stringify(event)).not.toContain(forbiddenBearer);
    expect(JSON.stringify(event)).not.toContain(forbiddenCookie);
    expect(JSON.stringify(event)).not.toContain(forbiddenPin);
    expect(JSON.stringify(event)).not.toContain(forbiddenOtp);
    expect(JSON.stringify(event)).not.toContain("guest@example.test");
    expect(JSON.stringify(event)).not.toContain(forbiddenPhone);
    expect(JSON.stringify(event)).not.toContain("Private message");
  });

  it("adds a server-generated request id and logs the matched route without reading request surfaces", async () => {
    const forbiddenPhone = ["+55", "11", "9", "99999999"].join("");
    const clientRequestId = forbiddenValue("client-request-id");
    const forbiddenBearer = `Bearer ${forbiddenValue("http-bearer")}`;
    const forbiddenCookie = `session=${forbiddenValue("http-cookie")}`;
    const events: unknown[] = [];
    let clockCall = 0;
    const api = new Hono<{ Variables: { observabilityRequestId: string } }>();
    api.use(
      "*",
      createObservabilityMiddleware({
        id: () => requestId,
        now: () => new Date(clockCall++ === 0 ? 1_000 : 1_042),
        sink: (event) => events.push(event),
      }),
    );
    api.get("/v1/sites/:siteId", (context) => context.json({ ok: true }));

    const response = await api.request(
      `https://api.example.test/v1/sites/site-demo?phone=${encodeURIComponent(forbiddenPhone)}`,
      {
        headers: {
          "X-Request-Id": clientRequestId,
          Authorization: forbiddenBearer,
          Cookie: forbiddenCookie,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "http.request",
      requestId,
      routeTemplate: "/v1/sites/:siteId",
      method: "GET",
      status: 200,
      durationMs: 42,
      operation: "request",
      result: "success",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(clientRequestId);
    expect(serialized).not.toContain(forbiddenBearer);
    expect(serialized).not.toContain(forbiddenCookie);
    expect(serialized).not.toContain(forbiddenPhone);
  });

  it("adds a request id to health and not-found responses in the composed app", async () => {
    const api = createApp(undefined, {
      id: () => requestId,
      now: () => new Date("2028-04-01T12:00:00.000Z"),
      sink: () => undefined,
    });

    const health = await api.request("/v1/health", {
      headers: { "X-Request-Id": "ignored" },
    });
    const missing = await api.request("/v1/does-not-exist");

    expect(health.headers.get("X-Request-Id")).toBe(requestId);
    expect(missing.headers.get("X-Request-Id")).toBe(requestId);
  });

  it("adds a request id to handled server errors without logging the error object", async () => {
    const events: unknown[] = [];
    const api = new Hono<{ Variables: { observabilityRequestId: string } }>();
    api.use(
      "*",
      createObservabilityMiddleware({
        id: () => requestId,
        now: () => new Date("2028-04-01T12:00:00.000Z"),
        sink: (event) => events.push(event),
      }),
    );
    const forbiddenErrorValue = forbiddenValue("error");
    api.onError(() => new Response("Internal failure", { status: 500 }));
    api.get("/v1/failure", () => {
      throw new Error(forbiddenErrorValue);
    });

    const response = await api.request("/v1/failure");

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(forbiddenErrorValue);
  });

  it("labels rate-limited responses without reading request data", async () => {
    const events: unknown[] = [];
    const api = new Hono<{ Variables: { observabilityRequestId: string } }>();
    api.use(
      "*",
      createObservabilityMiddleware({
        id: () => requestId,
        now: () => new Date("2028-04-01T12:00:00.000Z"),
        sink: (event) => events.push(event),
      }),
    );
    api.post("/v1/public/sites/:siteId/invitation/access", (context) =>
      context.json({ code: "LOOKUP_RATE_LIMITED" }, 429),
    );

    const response = await api.request(
      "https://api.example.test/v1/public/sites/site-demo/invitation/access",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ private: forbiddenValue("request-body") }),
      },
    );

    expect(response.status).toBe(429);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "http.request",
      routeTemplate: "/v1/public/sites/:siteId/invitation/access",
      status: 429,
      result: "failure",
      rateLimitOutcome: "limited",
    });
    expect(JSON.stringify(events)).not.toContain(
      forbiddenValue("request-body"),
    );
  });
});
