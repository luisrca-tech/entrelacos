import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHttpOptions } from "./authHttp";
import { createHandoffHttpRouter } from "./handoffHttp";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  issue: vi.fn(),
  redeem: vi.fn(),
  recognize: vi.fn(),
}));
vi.mock("./authHttp", () => ({ getAdministrativeSession: mocks.actor }));
vi.mock("./handoff", () => ({
  issueHandoff: mocks.issue,
  redeemHandoff: mocks.redeem,
  recognizeSite: mocks.recognize,
}));
const panel = "https://panel.example.test";
const origin = "https://wedding.example.test";
const body = { siteId: "one", origin, challenge: "a".repeat(64) };
let rows: unknown[];
const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  }),
};
const router = () =>
  createHandoffHttpRouter({
    db,
    adminOrigin: panel,
  } as unknown as AuthHttpOptions);
function request(path: string, payload: unknown, requestOrigin: string) {
  return new Request(`https://api.example.test/v1/handoff${path}`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [{ id: "registered" }];
  mocks.actor.mockResolvedValue({
    user: { role: "SITE_ADMIN", id: "admin" },
    siteId: "one",
    session: { id: "session" },
  });
  mocks.issue.mockResolvedValue({
    code: "c".repeat(43),
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  });
});
describe("handoff HTTP authorization", () => {
  it("issues only for an authorized wedding and registered origin", async () => {
    expect((await router().fetch(request("", body, panel))).status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        siteId: "one",
        parentSessionId: "session",
        challenge: body.challenge,
      }),
    );
    rows = [];
    expect((await router().fetch(request("", body, panel))).status).toBe(403);
  });
  it("rejects foreign panel origins and another tenant before issuance", async () => {
    expect((await router().fetch(request("", body, origin))).status).toBe(403);
    mocks.actor.mockResolvedValue({
      user: { role: "SITE_ADMIN" },
      siteId: "two",
      session: { id: "session" },
    });
    expect((await router().fetch(request("", body, panel))).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("requires public request Origin to equal the bound body origin", async () => {
    const payload = {
      siteId: "one",
      origin,
      code: "c".repeat(43),
      verifier: "v".repeat(43),
    };
    expect(
      (await router().fetch(request("/redeem", payload, "https://other.test")))
        .status,
    ).toBe(403);
    expect(mocks.redeem).not.toHaveBeenCalled();
    mocks.redeem.mockResolvedValue({
      recognitionToken: "r".repeat(43),
      expiresAt: new Date(),
    });
    const response = await router().fetch(request("/redeem", payload, origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  it("never refreshes administrative activity for recognition or allows arbitrary preflight", async () => {
    mocks.recognize.mockResolvedValue(false);
    const response = await router().fetch(
      request(
        "/recognize",
        { siteId: "one", origin, recognitionToken: "r".repeat(43) },
        origin,
      ),
    );
    expect(await response.json()).toEqual({ recognized: false });
    expect(mocks.actor).not.toHaveBeenCalled();
    rows = [];
    expect(
      (
        await router().fetch(
          new Request("https://api.example.test/v1/handoff/redeem", {
            method: "OPTIONS",
            headers: { Origin: "https://outside.test" },
          }),
        )
      ).status,
    ).toBe(403);
  });
});
