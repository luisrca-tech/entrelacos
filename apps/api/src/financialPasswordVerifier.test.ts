import * as betterAuthCrypto from "better-auth/crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFinancialPasswordVerifier,
  type FinancialPasswordVerifierInput,
  FinancialPasswordVerifierServiceError,
} from "./financialPasswordVerifier";

const password = "123456";
let passwordHash: string;
vi.mock("better-auth/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/crypto")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
beforeAll(async () => {
  passwordHash = await betterAuthCrypto.hashPassword(password);
});

function fixture(
  rows: unknown[] = [{ password: passwordHash }],
  scope = { userId: "user-1", providerId: "credential", state: "ACTIVE" },
) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (!/^SELECT /i.test(sql))
        throw new Error("Only a projected credential read is allowed");
      const projection = sql.slice(0, sql.search(/\bFROM\b/i));
      if (
        /\*|access_token|refresh_token|id_token|email|role|session|verification/i.test(
          projection,
        )
      )
        throw new Error("Unexpected private credential projection");
      if (
        !/INNER JOIN "user" u ON u\.id = a\.user_id/i.test(sql) ||
        !/a\.user_id = \$1 AND a\.provider_id = 'credential' AND u\.state = 'ACTIVE' LIMIT 2/i.test(
          sql,
        )
      )
        throw new Error("Current credential scope is required");
      return {
        rows:
          scope.userId === params[0] &&
          scope.providerId === "credential" &&
          scope.state === "ACTIVE"
            ? rows
            : [],
      };
    },
  );
  const verifier = createFinancialPasswordVerifier(
    drizzle({ query } as unknown as NodePgClient),
  );
  return { verifier, query, queries };
}

async function unavailable(action: Promise<unknown>) {
  const error = await action.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(FinancialPasswordVerifierServiceError);
  expect(error).toMatchObject({
    status: 503,
    code: "FINANCIAL_PASSWORD_UNAVAILABLE",
    message: "Financial password verification is unavailable",
  });
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(passwordHash);
  return error;
}

describe("stored financial password verifier", () => {
  it.each(["user.1", "user:1"])(
    "verifies valid C1 user ID %s without changing identity",
    async (userId) => {
      const values = fixture([{ password: passwordHash }], {
        userId,
        providerId: "credential",
        state: "ACTIVE",
      });
      expect(await values.verifier.verifyPassword({ userId, password })).toBe(
        true,
      );
      expect(values.queries[0].params).toEqual([userId]);
    },
  );
  it("uses actual Better Auth crypto to verify the current stored credential password", async () => {
    const values = fixture();
    expect(
      await values.verifier.verifyPassword({ userId: "user-1", password }),
    ).toBe(true);
    expect(values.query).toHaveBeenCalledTimes(1);
    expect(values.queries[0].sql).toMatch(
      /^SELECT a\.password FROM "account" a INNER JOIN "user" u ON u\.id = a\.user_id/i,
    );
    expect(values.queries[0].sql).toMatch(
      /a\.user_id = \$1 AND a\.provider_id = 'credential' AND u\.state = 'ACTIVE' LIMIT 2/i,
    );
    expect(values.queries[0].params).toEqual(["user-1"]);
    expect(values.queries[0].params).not.toContain(password);
    expect(values.queries[0].params).not.toContain(passwordHash);
  });

  it("returns false for a wrong password through the actual crypto implementation", async () => {
    const values = fixture();
    expect(
      await values.verifier.verifyPassword({
        userId: "user-1",
        password: "incorrect-password",
      }),
    ).toBe(false);
    expect(values.query).toHaveBeenCalledTimes(1);
  });

  it.each([1, 200])(
    "preserves the current PIN-compatible password length boundary %i",
    async (length) => {
      const supplied = "7".repeat(length);
      const hash = await betterAuthCrypto.hashPassword(supplied);
      const values = fixture([{ password: hash }]);
      expect(
        await values.verifier.verifyPassword({
          userId: "user-1",
          password: supplied,
        }),
      ).toBe(true);
    },
  );

  it("does not trim the existing password or replace Better Auth Unicode normalization", async () => {
    const supplied = " 123456 ";
    const hash = await betterAuthCrypto.hashPassword(supplied);
    const values = fixture([{ password: hash }]);
    expect(
      await values.verifier.verifyPassword({
        userId: "user-1",
        password: supplied,
      }),
    ).toBe(true);
    expect(
      await values.verifier.verifyPassword({ userId: "user-1", password }),
    ).toBe(false);
    expect(
      await fixture().verifier.verifyPassword({
        userId: "user-1",
        password: "１２３４５６",
      }),
    ).toBe(true);
  });

  it.each([{ rows: [] }, { rows: [{ password: null }] }])(
    "returns false for an absent local credential or absent nullable hash: %j",
    async ({ rows }) => {
      const values = fixture(rows);
      expect(
        await values.verifier.verifyPassword({ userId: "user-1", password }),
      ).toBe(false);
      expect(values.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { userId: "user-1", providerId: "credential", state: "DISABLED" },
    { userId: "user-1", providerId: "credential", state: "PENDING" },
    { userId: "user-1", providerId: "oauth", state: "ACTIVE" },
    { userId: "other-user", providerId: "credential", state: "ACTIVE" },
  ])(
    "cannot verify another user, disabled account or noncredential provider: %j",
    async (scope) => {
      const values = fixture([{ password: passwordHash }], scope);
      expect(
        await values.verifier.verifyPassword({ userId: "user-1", password }),
      ).toBe(false);
      expect(values.query).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects ambiguous local credentials even when the first hash matches", async () => {
    const values = fixture([
      { password: passwordHash },
      { password: passwordHash },
    ]);
    await unavailable(
      values.verifier.verifyPassword({ userId: "user-1", password }),
    );
    expect(values.query).toHaveBeenCalledTimes(1);
  });

  it.each(
    [
      null,
      {},
      [],
      { password: 42 },
      { password: undefined },
      { password: "" },
      { password: "not-a-hash" },
      { password: "salt:key" },
    ].map((row) => ({ row })),
  )("rejects malformed projected credential rows: %j", async ({ row }) => {
    await unavailable(
      fixture([row]).verifier.verifyPassword({ userId: "user-1", password }),
    );
  });

  it("rejects unexpected fields instead of retaining provider tokens from a malformed projection", async () => {
    const values = fixture([
      {
        password: passwordHash,
        accessToken: "private-token",
        refreshToken: "private-token",
      },
    ]);
    const error = await unavailable(
      values.verifier.verifyPassword({ userId: "user-1", password }),
    );
    expect(JSON.stringify(error)).not.toContain("private-token");
  });

  it("rejects a trailing component that the installed crypto parser would otherwise ignore", async () => {
    const values = fixture([{ password: `${passwordHash}:ignored` }]);
    await unavailable(
      values.verifier.verifyPassword({ userId: "user-1", password }),
    );
  });

  it.each([
    `${"x".repeat(32)}:${"a".repeat(128)}`,
    `${"a".repeat(31)}:${"a".repeat(128)}`,
    `${"a".repeat(32)}:${"a".repeat(127)}`,
    `${"a".repeat(32)}:${"a".repeat(129)}`,
    `${"a".repeat(32)}:${"g".repeat(128)}`,
  ])(
    "rejects malformed installed scrypt encoding without treating it as a wrong password",
    async (hash) => {
      await unavailable(
        fixture([{ password: hash }]).verifier.verifyPassword({
          userId: "user-1",
          password,
        }),
      );
    },
  );

  it.each([null, {}, { rows: null }, { rows: {} }, { rows: [null] }])(
    "sanitizes an invalid driver result: %j",
    async (result) => {
      const verifier = createFinancialPasswordVerifier({
        execute: vi.fn().mockResolvedValue(result),
      } as never);
      await unavailable(
        verifier.verifyPassword({ userId: "user-1", password }),
      );
    },
  );

  it("sanitizes storage errors without password/hash/raw database cause", async () => {
    const values = fixture();
    values.query.mockRejectedValueOnce(
      new Error(
        `postgresql://user:private@database; password=${password}; hash=${passwordHash}`,
      ),
    );
    const error = await unavailable(
      values.verifier.verifyPassword({ userId: "user-1", password }),
    );
    expect(String(error)).not.toMatch(/postgresql|private|123456/);
    expect(JSON.stringify(error)).not.toContain(passwordHash);
  });

  it("sanitizes crypto failures without retaining the password/hash/raw cause", async () => {
    const failure = vi
      .mocked(betterAuthCrypto.verifyPassword)
      .mockClear()
      .mockRejectedValueOnce(
        new Error(`crypto secret=${password}; hash=${passwordHash}`),
      );
    try {
      const error = await unavailable(
        fixture().verifier.verifyPassword({ userId: "user-1", password }),
      );
      expect(String(error)).not.toMatch(/secret|123456/);
      expect(JSON.stringify(error)).not.toContain(passwordHash);
    } finally {
      expect(failure).toHaveBeenCalledTimes(1);
      failure.mockReset();
    }
  });

  it.each([
    null,
    { userId: "user-1", password: "" },
    { userId: "user-1", password: "7".repeat(201) },
    { userId: "user-1", password: 1 },
    { userId: "user-1", password: null },
    { userId: "", password },
    { userId: "user/other", password },
    { userId: "user-1", password, approved: true },
  ])(
    "denies invalid password input before a credential query: %j",
    async (input) => {
      const values = fixture();
      expect(
        await values.verifier.verifyPassword(
          input as FinancialPasswordVerifierInput,
        ),
      ).toBe(false);
      expect(values.query).not.toHaveBeenCalled();
    },
  );

  it("requires an executable stored database reader when creating the verifier", () => {
    expect(() => createFinancialPasswordVerifier({} as never)).toThrow(
      FinancialPasswordVerifierServiceError,
    );
  });
});
