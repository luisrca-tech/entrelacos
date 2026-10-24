import { describe, expect, it, vi } from "vitest";
import { createFinancialReauthentication } from "./financialReauthentication";

function fixture() {
  const actor = {
    userId: "admin-one",
    siteId: "site-one",
    sessionId: "session-one",
  };
  const clock = { value: new Date("2026-10-12T18:00:00.000Z") };
  const consume = vi.fn().mockResolvedValue(true);
  const verifyPassword = vi.fn().mockResolvedValue(true);
  const options = {
    keyId: "local-key",
    key: new Uint8Array(32).fill(17),
    maxAgeMs: 120000,
    now: () => new Date(clock.value),
    rateLimit: { consume },
    password: { verifyPassword },
  };
  return { actor, clock, consume, verifyPassword, options };
}

describe("financial password reauthentication", () => {
  it("issues and reads only backend-verified same-session/action evidence", async () => {
    const v = fixture();
    const service = createFinancialReauthentication(v.options);
    const response = await service.authenticate(
      v.actor,
      "REQUEST_WITHDRAWAL",
      "test-only-password",
    );
    expect(v.consume).toHaveBeenCalledExactlyOnceWith("admin-one");
    expect(v.verifyPassword).toHaveBeenCalledExactlyOnceWith({
      userId: "admin-one",
      password: "test-only-password",
    });
    expect(v.consume.mock.invocationCallOrder[0]).toBeLessThan(
      v.verifyPassword.mock.invocationCallOrder[0],
    );
    expect(response.expiresAt).toBe("2026-10-12T18:02:00.000Z");
    expect(
      service.readProof(
        v.actor,
        "REQUEST_WITHDRAWAL",
        response.reauthenticationToken,
      ),
    ).toEqual({
      ...v.actor,
      proofKind: "PASSWORD_REAUTHENTICATION",
      verification: "verified",
      provenance: "backend",
      authenticatedAt: v.clock.value,
      expiresAt: new Date(response.expiresAt),
    });
    expect(response.reauthenticationToken).not.toContain("test-only-password");
  });
  it.each([false, undefined, "true"])(
    "never signs after unsuccessful password result %j",
    async (result) => {
      const v = fixture();
      v.verifyPassword.mockResolvedValue(result);
      await expect(
        createFinancialReauthentication(v.options).authenticate(
          v.actor,
          "CONFIGURE_RECEIVING",
          "test-only-password",
        ),
      ).rejects.toMatchObject({ status: 403, code: "RECENT_AUTH_REQUIRED" });
    },
  );
  it("limits attempts before touching password verification", async () => {
    const v = fixture();
    v.consume.mockResolvedValue(false);
    await expect(
      createFinancialReauthentication(v.options).authenticate(
        v.actor,
        "REQUEST_WITHDRAWAL",
        "test-only-password",
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "REAUTHENTICATION_RATE_LIMITED",
    });
    expect(v.verifyPassword).not.toHaveBeenCalled();
  });
  it.each(["password", "limiter"])("sanitizes %s failures", async (stage) => {
    const v = fixture();
    (stage === "password" ? v.verifyPassword : v.consume).mockRejectedValue(
      new Error("private-credential-database"),
    );
    const error = await createFinancialReauthentication(v.options)
      .authenticate(v.actor, "REQUEST_WITHDRAWAL", "test-only-password")
      .catch((e) => e);
    expect(error).toMatchObject({
      status: 503,
      code: "REAUTHENTICATION_UNAVAILABLE",
    });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("private");
  });
  it.each([
    "userId",
    "siteId",
    "sessionId",
    "action",
    "key",
    "payload",
    "signature",
    "noncanonical",
  ])("rejects mismatched or tampered proof %s", async (variant) => {
    const v = fixture();
    const service = createFinancialReauthentication(v.options);
    const response = await service.authenticate(
      v.actor,
      "REQUEST_WITHDRAWAL",
      "test-only-password",
    );
    const actor = { ...v.actor };
    let token = response.reauthenticationToken;
    let action = "REQUEST_WITHDRAWAL" as
      | "REQUEST_WITHDRAWAL"
      | "CONFIGURE_RECEIVING";
    if (variant === "userId" || variant === "siteId" || variant === "sessionId")
      actor[variant] = "another-one";
    if (variant === "action") action = "CONFIGURE_RECEIVING";
    if (variant === "payload") {
      const parts = token.split(".");
      parts[1] = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(parts[1], "base64url").toString()),
          siteId: "another-site",
        }),
      ).toString("base64url");
      token = parts.join(".");
    }
    if (variant === "signature") {
      const parts = token.split(".");
      parts[2] = Buffer.alloc(32, 0).toString("base64url");
      token = parts.join(".");
    }
    if (variant === "noncanonical") token += "=";
    const verifier =
      variant === "key"
        ? createFinancialReauthentication({
            ...v.options,
            key: new Uint8Array(32).fill(18),
          })
        : service;
    expect(() =>
      verifier.readProof(
        actor,
        action,
        variant === "key" ? response.reauthenticationToken : token,
      ),
    ).toThrow(expect.objectContaining({ code: "RECENT_AUTH_REQUIRED" }));
  });
  it.each(["expired", "future"])("rejects %s proof", async (variant) => {
    const v = fixture();
    const service = createFinancialReauthentication(v.options);
    const response = await service.authenticate(
      v.actor,
      "REQUEST_WITHDRAWAL",
      "test-only-password",
    );
    v.clock.value = new Date(
      variant === "expired"
        ? "2026-10-12T18:02:00.000Z"
        : "2026-10-12T17:59:59.000Z",
    );
    expect(() =>
      service.readProof(
        v.actor,
        "REQUEST_WITHDRAWAL",
        response.reauthenticationToken,
      ),
    ).toThrow(expect.objectContaining({ code: "RECENT_AUTH_REQUIRED" }));
  });
  it("copies key and actor, and timestamps after asynchronous verification", async () => {
    const v = fixture();
    const service = createFinancialReauthentication(v.options);
    v.options.key.fill(0);
    v.verifyPassword.mockImplementation(async () => {
      v.clock.value = new Date("2026-10-12T18:00:30.000Z");
      v.actor.userId = "changed";
      return true;
    });
    const response = await service.authenticate(
      v.actor,
      "REQUEST_WITHDRAWAL",
      "test-only-password",
    );
    expect(response.expiresAt).toBe("2026-10-12T18:02:30.000Z");
    expect(
      service.readProof(
        { ...v.actor, userId: "admin-one" },
        "REQUEST_WITHDRAWAL",
        response.reauthenticationToken,
      ).userId,
    ).toBe("admin-one");
  });
  it.each([0, 300001, NaN, Infinity])(
    "requires bounded proof age %j",
    async (maxAgeMs) => {
      const v = fixture();
      expect(() =>
        createFinancialReauthentication({ ...v.options, maxAgeMs }),
      ).toThrow(
        expect.objectContaining({ code: "REAUTHENTICATION_UNAVAILABLE" }),
      );
    },
  );
  it.each(["", "x".repeat(201)])(
    "rejects invalid password before verifier",
    async (password) => {
      const v = fixture();
      await expect(
        createFinancialReauthentication(v.options).authenticate(
          v.actor,
          "REQUEST_WITHDRAWAL",
          password,
        ),
      ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
      expect(v.verifyPassword).not.toHaveBeenCalled();
    },
  );
});
