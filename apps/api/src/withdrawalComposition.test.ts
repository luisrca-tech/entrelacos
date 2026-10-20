import type { WithdrawalRequestContext } from "@entrelacos/contracts";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWithdrawalComposition } from "./withdrawalComposition";
import * as withdrawalRepository from "./withdrawalReservationRepository";

describe("native withdrawal runtime composition", () => {
  it("leaves disabled and production configurations without dispatch services", () => {
    const db = { execute: vi.fn(), transaction: vi.fn() };
    const disabled = createWithdrawalComposition(
      { mode: "disabled" },
      { db: db as never },
    );
    expect(disabled.service).toBeUndefined();
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("native withdrawal maximum fee quote", () => {
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    environment: "sandbox" as const,
    bankReference: "bank-1",
    destinationVersion: 1,
    amountCents: 1000,
    currency: "BRL" as const,
  };
  const now = new Date("2026-10-19T10:00:00.000Z");
  const observation = () => ({
    source: "provider" as const,
    provider: "ASAAS" as const,
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    accountReference: scope.accountReference,
    environment: "sandbox" as const,
    currency: "BRL" as const,
    observedAt: new Date(now),
    completedAt: new Date(now),
    fees: {
      transfer: {
        monthlyTransfersWithoutFee: 30,
        pix: {
          feeValue: "2.00",
          discountValue: "0.00",
          consideredInMonthlyTransfersWithoutFee: true,
        },
      },
    },
  });
  it("uses the observed full base fee instead of promising a monthly free quota", async () => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    expect(
      quoteAsaasWithdrawalMaximumFee(scope, observation(), now),
    ).toMatchObject({
      feeCents: 200,
      feeSemantics: "MAXIMUM",
      provenance: "provider",
      verification: "verified",
    });
  });
  it.each([
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
    "source",
    "provider",
    "currency",
  ])("rejects foreign %s in fee authority", async (key) => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    const value = observation();
    (value as Record<string, unknown>)[key] = "foreign";
    expect(() => quoteAsaasWithdrawalMaximumFee(scope, value, now)).toThrow();
  });
  it("rejects stale fees and an amount that cannot cover the approved maximum", async () => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    expect(() =>
      quoteAsaasWithdrawalMaximumFee(
        scope,
        observation(),
        new Date(+now + 60001),
      ),
    ).toThrow();
    expect(() =>
      quoteAsaasWithdrawalMaximumFee(
        { ...scope, amountCents: 200 },
        observation(),
        now,
      ),
    ).toThrow();
  });
});

function enabledFixture(refreshReceiving?: (siteId: string) => Promise<void>) {
  const clock = { value: new Date("2026-10-19T10:00:00.000Z") };
  const execute = vi.fn(async (_statement: SQL) => ({
    rows: [] as Record<string, unknown>[],
  }));
  const tx = { execute };
  const db = {
    execute,
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  const key = new Uint8Array(32).fill(7);
  const config = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    platformApiKey: "$aact_hmlg_offline-platform-token",
    platformAccountId: "platform-1",
    platformWalletId: "wallet-platform-1",
    credentialKeyId: "key-1",
    credentialKeyring: new Map([["key-1", key]]),
    webhookPublicOrigin: "https://webhook.example.test",
    webhookUrl: "https://webhook.example.test/v1/webhooks/asaas",
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const composition = createWithdrawalComposition(config, {
    db: db as never,
    fetch,
    now: () => clock.value,
    ...(refreshReceiving ? { refreshReceiving } : {}),
  });
  const intent = {
    id: "withdrawal-1",
    siteId: "site-1",
    amountCents: 1000,
    feeCents: 200,
    netCents: 800,
    currency: "BRL" as const,
    destinationVersion: 1,
    state: "PROCESSING" as const,
    createdAt: clock.value.toISOString(),
    updatedAt: clock.value.toISOString(),
    mode: "sandbox" as const,
  };
  return { clock, execute, db, config, fetch, composition, intent, key };
}
describe("composed withdrawal admission and recovery ownership", () => {
  it("reads stored provider presentation when the runtime supplies receiving refresh", async () => {
    const factory = vi.spyOn(
      withdrawalRepository,
      "createWithdrawalReservationRepository",
    );
    const refresh = vi.fn(async (_siteId: string) => {});
    const f = enabledFixture(refresh);
    try {
      const options = factory.mock.calls[0][1];
      if (options.mode === "disabled")
        throw new Error("Missing Sandbox options");
      const loader = options.loadVerifiedPresentationInTransaction;
      if (!loader) throw new Error("Missing stored presentation loader");
      await expect(
        loader({ execute: f.execute } as never, {
          siteId: "site-1",
          accountId: "account-1",
          accountReference: "acct-1",
          environment: "sandbox",
          bankReference: "bank-1",
          destinationVersion: 1,
        }),
      ).resolves.toBeNull();
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(
        new PgDialect().sqlToQuery(f.execute.mock.calls[0][0]).sql,
      ).toContain("JOIN LATERAL");
      expect(refresh).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      await f.composition.close();
      factory.mockRestore();
    }
  });
  it("exposes protected request services without eager database or provider operations", async () => {
    const f = enabledFixture();
    expect(f.composition.service?.confirmNew).toBeTypeOf("function");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await f.composition.close();
    expect([...f.key]).toEqual(Array(32).fill(7));
    await expect(
      f.composition.service?.readContext({ actor: null, access: null }),
    ).rejects.toThrow("closed");
  });
  it("bounds recovery scans to one every30 seconds and only reads existing attempted operations", async () => {
    const f = enabledFixture();
    await f.composition.reconcilePending();
    await f.composition.reconcilePending();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    f.clock.value = new Date(+f.clock.value + 30001);
    await f.composition.reconcilePending();
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.composition.close();
  });
  it("retains MAXIMUM semantics for a pending history item without manufacturing a settlement", async () => {
    const f = enabledFixture();
    f.execute.mockResolvedValue({
      rows: [
        {
          reference: null,
          snapshot: { feeQuote: { feeSemantics: "MAXIMUM" } },
        },
      ],
    });
    expect(await f.composition.decorateIntent(f.intent)).toEqual({
      ...f.intent,
      feeSemantics: "MAXIMUM",
    });
    await f.composition.close();
  });
  it("does not manufacture completion for a max-budget intent without immutable custody", async () => {
    const f = enabledFixture();
    f.execute.mockResolvedValueOnce({
      rows: [
        {
          reference: "missing",
          snapshot: { feeQuote: { feeSemantics: "MAXIMUM" } },
        },
      ],
    });
    await expect(
      f.composition.decorateIntent({ ...f.intent, state: "COMPLETED" }),
    ).rejects.toThrow();
    await f.composition.close();
  });
});

describe("composed withdrawal context refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  const attempt = {
    actor: { userId: "user-1", siteId: "site-1", sessionId: "session-1" },
    access: {
      siteId: "site-1",
      userId: "user-1",
      membershipId: "membership-1",
      membershipRole: "SITE_ADMIN" as const,
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: true,
        readFinance: true,
        configureReceiving: true,
        requestWithdrawal: false,
      },
    },
  };
  function context(
    reason: WithdrawalRequestContext["reason"],
  ): WithdrawalRequestContext {
    return {
      siteId: "site-1",
      mode: "sandbox",
      scopeRevision: "0",
      observedAt: "2026-10-19T10:00:00.000Z",
      observationOrder: {
        scopeRevision: "0",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: reason === null,
      reason,
      openRequest: null,
      recoverableRequests: [],
      nextCursor: null,
    };
  }
  function contextFixture(
    refreshReceiving?: (siteId: string) => Promise<void>,
  ) {
    const createRepository =
      withdrawalRepository.createWithdrawalReservationRepository;
    const readContext = vi.fn(async () => context("DESTINATION_UNAVAILABLE"));
    vi.spyOn(
      withdrawalRepository,
      "createWithdrawalReservationRepository",
    ).mockImplementation((db, options) => ({
      ...createRepository(db, options),
      readContext,
    }));
    return { ...enabledFixture(refreshReceiving), readContext };
  }

  it("refreshes an unavailable destination after authorization and rereads its context", async () => {
    const calls: string[] = [];
    const refresh = vi.fn(async (siteId: string) => {
      calls.push(`refresh:${siteId}`);
    });
    const f = contextFixture(refresh);
    f.readContext
      .mockImplementationOnce(async () => {
        calls.push("authorized read");
        return context("DESTINATION_UNAVAILABLE");
      })
      .mockImplementationOnce(async () => {
        calls.push("authorized reread");
        return context(null);
      });
    try {
      expect(await f.composition.service?.readContext(attempt)).toEqual(
        context(null),
      );
      expect(calls).toEqual([
        "authorized read",
        "refresh:site-1",
        "authorized reread",
      ]);
      expect(refresh).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      await f.composition.close();
    }
  });

  it("does not repeat refresh when the destination remains unavailable", async () => {
    const refresh = vi.fn(async (_siteId: string) => {});
    const f = contextFixture(refresh);
    try {
      expect(await f.composition.service?.readContext(attempt)).toEqual(
        context("DESTINATION_UNAVAILABLE"),
      );
      expect(refresh).toHaveBeenCalledOnce();
      expect(f.readContext).toHaveBeenCalledTimes(2);
    } finally {
      await f.composition.close();
    }
  });

  it("preserves an unavailable context when no refresh port is configured", async () => {
    const f = contextFixture();
    try {
      expect(await f.composition.service?.readContext(attempt)).toEqual(
        context("DESTINATION_UNAVAILABLE"),
      );
      expect(f.readContext).toHaveBeenCalledOnce();
    } finally {
      await f.composition.close();
    }
  });

  it.each([null, "NOT_CONFIGURED", "RECIPIENT_REQUIRED"] as const)(
    "does not refresh an authorized context with reason %s",
    async (reason) => {
      const refresh = vi.fn(async (_siteId: string) => {});
      const f = contextFixture(refresh);
      f.readContext.mockResolvedValue(context(reason));
      try {
        expect(await f.composition.service?.readContext(attempt)).toEqual(
          context(reason),
        );
        expect(refresh).not.toHaveBeenCalled();
        expect(f.readContext).toHaveBeenCalledOnce();
      } finally {
        await f.composition.close();
      }
    },
  );

  it("preserves unresolved obligations and their existing request history", async () => {
    const refresh = vi.fn(async (_siteId: string) => {});
    const f = contextFixture(refresh);
    const existing = {
      ...context("UNRESOLVED_OPERATION"),
      recoverableRequests: [
        {
          siteId: "site-1",
          mode: "sandbox" as const,
          requestId: "request-1",
          requestRevision: null,
          scopeRevision: "0",
          observedAt: f.clock.value.toISOString(),
          observationOrder: {
            scopeRevision: "0",
            requestRevision: null,
            recordUpdatedAtMicroseconds: (
              BigInt(+f.clock.value) * 1000n
            ).toString(),
          },
          state: "EXISTING" as const,
          command: {
            requestId: "request-1",
            amountCents: f.intent.amountCents,
            destinationVersion: f.intent.destinationVersion,
          },
          withdrawal: f.intent,
          preview: null,
        },
      ],
    };
    f.readContext.mockResolvedValue(existing);
    try {
      expect(await f.composition.service?.readContext(attempt)).toEqual(
        existing,
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(f.readContext).toHaveBeenCalledOnce();
    } finally {
      await f.composition.close();
    }
  });

  it("sanitizes a receiving refresh failure without rereading or inventing readiness", async () => {
    const refresh = vi.fn(async (_siteId: string) => {
      throw new Error("private-provider-refresh-detail");
    });
    const f = contextFixture(refresh);
    try {
      const error = await f.composition.service
        ?.readContext(attempt)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 503,
        code: "WITHDRAWAL_UNAVAILABLE",
      });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private-provider-refresh-detail");
      expect(refresh).toHaveBeenCalledOnce();
      expect(f.readContext).toHaveBeenCalledOnce();
    } finally {
      await f.composition.close();
    }
  });

  it.each(["signed-out", "owner", "cross-site"])(
    "does not refresh before the real service and repository reject %s access",
    async (kind) => {
      const refresh = vi.fn(async (_siteId: string) => {});
      const f = enabledFixture(refresh);
      f.execute.mockImplementation(async (statement) => {
        const text = new PgDialect().sqlToQuery(statement).sql;
        if (text.includes('AS "currentTime"'))
          return { rows: [{ currentTime: f.clock.value }] };
        if (text.includes('FROM "site" st'))
          return { rows: [{ siteId: "site-1", isDemo: true }] };
        if (text.includes('FROM "user" u'))
          return {
            rows: [
              {
                userId: "user-1",
                role: "OWNER",
                state: "ACTIVE",
                operatorDisplayName: "Owner",
                operatorProfileUpdatedAt: f.clock.value,
              },
            ],
          };
        throw new Error("Unexpected authorization query");
      });
      const selected =
        kind === "signed-out"
          ? { ...attempt, actor: null }
          : kind === "owner"
            ? {
                ...attempt,
                access: {
                  ...attempt.access,
                  membershipId: null,
                  membershipRole: "OWNER" as const,
                  capabilities: {
                    ...attempt.access.capabilities,
                    configureReceiving: false,
                  },
                },
              }
            : {
                ...attempt,
                actor: { ...attempt.actor, siteId: "site-other" },
              };
      try {
        await expect(
          f.composition.service?.readContext(selected),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED" });
        expect(refresh).not.toHaveBeenCalled();
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        await f.composition.close();
      }
    },
  );
});
