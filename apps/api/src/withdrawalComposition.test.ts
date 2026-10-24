import {
  receivingSetupConsentVersion,
  type WithdrawalRequestContext,
} from "@entrelacos/contracts";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as asaasHttpModule from "./asaasHttpClient";
import * as storedAccountModule from "./asaasStoredAccountReader";
import * as transferModule from "./asaasTransferClient";
import * as authorizationModule from "./asaasWithdrawalAuthorization";
import * as custodyModule from "./asaasWithdrawalCustody";
import * as credentialModule from "./providerCredentials";
import {
  createWithdrawalComposition,
  verifyAsaasWithdrawalDispatchBudget,
} from "./withdrawalComposition";
import * as executionModule from "./withdrawalExecution";
import * as payoutModule from "./withdrawalPayout";
import * as postingModule from "./withdrawalPostingRepository";
import * as withdrawalRepository from "./withdrawalReservationRepository";
import * as reservationModule from "./withdrawalReservations";

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
  it("quotes an account-bound live gross budget with a minimum net", async () => {
    const { quoteAsaasWithdrawalMaximumFee } = await import(
      "./withdrawalComposition"
    );
    expect(
      quoteAsaasWithdrawalMaximumFee(
        { ...scope, environment: "live" },
        { ...observation(), environment: "live" },
        now,
      ),
    ).toMatchObject({
      feeCents: 200,
      feeSemantics: "MAXIMUM_WITH_MINIMUM_NET",
      environment: "live",
    });
  });
  it.each([0, 30_000, 60_000])(
    "gives a new maximum fee quote five minutes from its observation after %ims without renewing that observation",
    async (elapsed) => {
      const { quoteAsaasWithdrawalMaximumFee } = await import(
        "./withdrawalComposition"
      );
      const observed = observation();
      const quote = quoteAsaasWithdrawalMaximumFee(
        scope,
        observed,
        new Date(+now + elapsed),
      );
      expect(quote.observedAt).toEqual(now);
      expect(quote.expiresAt).toEqual(new Date(+now + 300_000));
      expect(observed.observedAt).toEqual(now);
    },
  );
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

function enabledFixture(
  refreshReceiving?: (siteId: string) => Promise<void>,
  authorization = false,
  live = false,
) {
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
    mode: live ? ("live" as const) : ("sandbox" as const),
    applicationEnvironment: live ? ("production" as const) : ("test" as const),
    ...(live ? { liveDemoSiteId: "demo-wedding" } : {}),
    platformApiKey: "$aact_hmlg_offline-platform-token",
    platformAccountId: "platform-1",
    platformWalletId: "wallet-platform-1",
    credentialKeyId: "key-1",
    credentialKeyring: new Map([["key-1", key]]),
    webhookPublicOrigin: "https://webhook.example.test",
    webhookUrl: "https://webhook.example.test/v1/webhooks/asaas",
    ...(authorization
      ? {
          withdrawalAuthorization: {
            token: "offline-authorization-token-123456789",
            url: "https://webhook.example.test/v1/webhooks/asaas/withdrawal-authorization",
          },
        }
      : {}),
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
    f.execute.mockResolvedValue({ rows: [{ reference: null, snapshot: {} }] });
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

  it.each(["valid", "missing", "foreign"] as const)(
    "reads completed context settlements through immutable custody proof: %s",
    async (kind) => {
      const createCustody = custodyModule.createAsaasWithdrawalCustody;
      const proof = vi.fn(async () =>
        kind !== "missing"
          ? {
              outcome: "COMPLETED",
              correlation: {
                siteId: kind === "foreign" ? "other-site" : "site-1",
              },
              totalDebitCents: 800,
              feeCents: 0,
              netCents: 800,
            }
          : null,
      );
      vi.spyOn(
        custodyModule,
        "createAsaasWithdrawalCustody",
      ).mockImplementation((db, options) => ({
        ...createCustody(db, options),
        loadCompletionProofInTransaction: proof as never,
      }));
      const f = contextFixture();
      const withdrawal = {
        ...f.intent,
        state: "COMPLETED" as const,
        feeSemantics: "MAXIMUM" as const,
      };
      const row = {
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
          amountCents: withdrawal.amountCents,
          destinationVersion: withdrawal.destinationVersion,
        },
        withdrawal,
        preview: null,
      };
      const raw = { ...context(null), recoverableRequests: [row] };
      f.readContext.mockResolvedValue(raw);
      f.execute.mockImplementation(async (statement) => {
        const text = new PgDialect().sqlToQuery(statement).sql;
        if (text.includes("SELECT w.receipt_reference"))
          return {
            rows: [
              {
                reference: "receipt-1",
                snapshot: { feeQuote: { feeSemantics: "MAXIMUM" } },
              },
            ],
          };
        if (
          text.includes("SELECT payload FROM withdrawal_provider_observation")
        )
          return {
            rows: [
              {
                payload: {
                  original: { correlation: { withdrawalId: withdrawal.id } },
                  fence: {},
                },
              },
            ],
          };
        throw new Error("Unexpected settlement query");
      });
      try {
        if (kind === "valid") {
          expect(await f.composition.service?.readContext(attempt)).toEqual({
            ...raw,
            recoverableRequests: [
              {
                ...row,
                withdrawal: {
                  ...withdrawal,
                  settlement: {
                    totalDebitCents: 800,
                    feeCents: 0,
                    netCents: 800,
                    releasedCents: 200,
                  },
                },
              },
            ],
          });
        } else {
          await expect(
            f.composition.service?.readContext(attempt),
          ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE" });
        }
        expect(proof).toHaveBeenCalledOnce();
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        await f.composition.close();
      }
    },
  );

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

describe("protected existing withdrawal refresh", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["success", "denied", "refreshFailure"])(
    "refreshes only after successful existing recovery and before arming: %s",
    async (outcome) => {
      const calls: string[] = [];
      const refresh = vi.fn(async (_siteId: string) => {
        calls.push("refresh");
        if (outcome === "refreshFailure") throw new Error("unavailable");
      });
      const recoverExisting = vi.fn(async () => {
        calls.push("authorized recovery");
        if (outcome === "denied") throw new Error("denied");
        return { siteId: "site-1", state: "REQUESTED" };
      });
      const executeExisting = vi.fn(async () => {
        calls.push("arm");
        return { outcome: "DENIED" };
      });
      vi.spyOn(
        reservationModule,
        "createWithdrawalReservationService",
      ).mockReturnValue({ recoverExisting } as never);
      vi.spyOn(
        executionModule,
        "createWithdrawalExecutionService",
      ).mockReturnValue({ executeExisting } as never);
      const createRepository =
        withdrawalRepository.createWithdrawalReservationRepository;
      vi.spyOn(
        withdrawalRepository,
        "createWithdrawalReservationRepository",
      ).mockImplementation((db, options) => ({
        ...createRepository(db, options),
        findByRequest: vi.fn(async () => null),
      }));
      const f = enabledFixture(refresh);
      try {
        const attempt = {
          actor: { siteId: "site-1" },
          requestId: "request-1",
        } as never;
        if (outcome === "success") {
          await f.composition.service?.recoverExisting(attempt);
          expect(calls).toEqual(["authorized recovery", "refresh", "arm"]);
        } else {
          await expect(
            f.composition.service?.recoverExisting(attempt),
          ).rejects.toThrow();
          expect(calls).toEqual(
            outcome === "denied"
              ? ["authorized recovery"]
              : ["authorized recovery", "refresh"],
          );
          expect(executeExisting).not.toHaveBeenCalled();
        }
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        await f.composition.close();
      }
    },
  );
});

it.each(["PROCESSING", "UNKNOWN", "COMPLETED"])(
  "preserves attempted or settled %s recovery without refreshing current receiving",
  async (state) => {
    const refresh = vi.fn(async (_siteId: string) => {
      throw new Error("current receiving unavailable");
    });
    const recoverExisting = vi.fn(async () => ({ siteId: "site-1", state }));
    const executeExisting = vi.fn(async () => ({ outcome: "DENIED" }));
    const reservationSpy = vi
      .spyOn(reservationModule, "createWithdrawalReservationService")
      .mockReturnValue({ recoverExisting } as never);
    const executionSpy = vi
      .spyOn(executionModule, "createWithdrawalExecutionService")
      .mockReturnValue({ executeExisting } as never);
    const createRepository =
      withdrawalRepository.createWithdrawalReservationRepository;
    const repositorySpy = vi
      .spyOn(withdrawalRepository, "createWithdrawalReservationRepository")
      .mockImplementation((db, options) => ({
        ...createRepository(db, options),
        findByRequest: vi.fn(async () => null),
      }));
    const f = enabledFixture(refresh);
    try {
      await expect(
        f.composition.service?.recoverExisting({
          actor: { siteId: "site-1" },
          requestId: "request-1",
        } as never),
      ).resolves.toEqual({ siteId: "site-1", state });
      expect(refresh).not.toHaveBeenCalled();
      expect(executeExisting).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      await f.composition.close();
      reservationSpy.mockRestore();
      executionSpy.mockRestore();
      repositorySpy.mockRestore();
    }
  },
);

describe("current native withdrawal budget", () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  function budget() {
    const correlation = {
      siteId: "site-1",
      accountId: "account-1",
      accountReference: "acct-1",
      environment: "sandbox",
      bankReference: "bank-1",
      destinationVersion: 1,
      amountCents: 300,
      feeCents: 200,
      netCents: 100,
      currency: "BRL",
    };
    const binding = {
      source: "provider" as const,
      provider: "ASAAS" as const,
      siteId: "site-1",
      accountBindingId: "account-1",
      accountReference: "acct-1",
      environment: "sandbox" as const,
      currency: "BRL" as const,
      observedAt: new Date(now),
    };
    return {
      original: { correlation } as executionModule.OriginalWithdrawal,
      fees: {
        ...binding,
        completedAt: new Date(now),
        fees: { transfer: { pix: { feeValue: "2.00" } } },
      },
      balance: { ...binding, balanceCents: 350 },
    };
  }
  it("requires the full approved own budget plus other held commitments exactly once", () => {
    const f = budget();
    expect(() =>
      verifyAsaasWithdrawalDispatchBudget(
        f.original,
        f.fees,
        f.balance,
        50n,
        now,
      ),
    ).not.toThrow();
    expect(() =>
      verifyAsaasWithdrawalDispatchBudget(
        f.original,
        f.fees,
        f.balance,
        51n,
        now,
      ),
    ).toThrow();
    f.fees.fees.transfer.pix.feeValue = "0.00";
    f.balance.balanceCents = 299;
    expect(() =>
      verifyAsaasWithdrawalDispatchBudget(
        f.original,
        f.fees,
        f.balance,
        0n,
        now,
      ),
    ).toThrow();
  });
  it.each([
    "siteId",
    "accountBindingId",
    "accountReference",
    "environment",
    "source",
    "provider",
    "currency",
  ])("rejects foreign %s in either native observation", (field) => {
    for (const source of ["fees", "balance"] as const) {
      const f = budget();
      (f[source] as Record<string, unknown>)[field] = "foreign";
      expect(() =>
        verifyAsaasWithdrawalDispatchBudget(
          f.original,
          f.fees,
          f.balance,
          0n,
          now,
        ),
      ).toThrow();
    }
  });
  it.each([
    "overFee",
    "malformedFee",
    "staleFees",
    "futureFees",
    "futureBalance",
    "staleBalance",
    "fractionalBalance",
    "negativeHolds",
  ])("rejects unusable current budget: %s", (kind) => {
    const f = budget();
    let held = 0n;
    if (kind === "overFee") f.fees.fees.transfer.pix.feeValue = "2.01";
    if (kind === "malformedFee") f.fees.fees.transfer.pix.feeValue = "NaN";
    if (kind === "staleFees") f.fees.observedAt = new Date(+now - 60_001);
    if (kind === "futureFees") f.fees.completedAt = new Date(+now + 1);
    if (kind === "futureBalance") f.balance.observedAt = new Date(+now + 1);
    if (kind === "staleBalance") f.balance.observedAt = new Date(+now - 60_001);
    if (kind === "fractionalBalance") f.balance.balanceCents = 350.5;
    if (kind === "negativeHolds") held = -1n;
    expect(() =>
      verifyAsaasWithdrawalDispatchBudget(
        f.original,
        f.fees,
        f.balance,
        held,
        now,
      ),
    ).toThrow();
  });
});

describe("composed native dispatch budget boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  function nativeFixture(authorization = false) {
    const adapterFactory = vi.spyOn(
      transferModule,
      "createAsaasWithdrawalTransferAdapter",
    );
    const postingFactory = vi.spyOn(
      postingModule,
      "createWithdrawalPostingRepository",
    );
    vi.spyOn(
      executionModule,
      "usesAcceptedMaximumWithdrawalDispatch",
    ).mockReturnValue(true);
    const binding = {
      destinationId: "pix-1",
      destinationVersion: 1,
      configurationHash: "a".repeat(64),
      reviewId: "review-1",
      holderId: "holder-1",
      holderConsentId: "holder-consent-1",
      acceptThirdParty: false,
      keyType: "EMAIL" as const,
      maskedKey: "j***@example.test",
      ownerName: "Joao Silva",
    };
    vi.spyOn(payoutModule, "createWithdrawalPayoutBinding").mockReturnValue(
      binding,
    );
    vi.spyOn(credentialModule, "decryptProviderCredential").mockImplementation(
      (envelope) =>
        (envelope as { ciphertext?: string }).ciphertext === "destination"
          ? JSON.stringify({
              purpose: "receiving-pix-key.v1",
              type: "EMAIL",
              key: "joao@example.test",
            })
          : "$aact_hmlg_offline-test-token",
    );
    const observed = {
      source: "provider" as const,
      provider: "ASAAS" as const,
      siteId: "site-1",
      accountBindingId: "account-1",
      accountReference: "acct-1",
      environment: "sandbox" as const,
      currency: "BRL" as const,
    };
    const fees = vi.fn(async () => ({
      ...observed,
      observedAt: f.clock.value,
      completedAt: f.clock.value,
      fees: { transfer: { pix: { feeValue: "2.00" } } },
    }));
    const balance = vi.fn(async () => ({
      ...observed,
      observedAt: f.clock.value,
      balanceCents: 350,
    }));
    const post = vi.fn(async () => ({ provider: "ASAAS" }));
    vi.spyOn(asaasHttpModule, "createAsaasHttpClient").mockReturnValue({
      getAccountFees: fees,
      getBalance: balance,
      createPixTransfer: post,
      getTransfer: vi.fn(),
      listTransfers: vi.fn(),
    } as never);
    const f = enabledFixture(undefined, authorization);
    const correlation = {
      siteId: "site-1",
      requestId: "request-1",
      requestHash: "b".repeat(64),
      withdrawalId: "withdrawal-1",
      operationId: "operation-1",
      accountId: "account-1",
      accountReference: "acct-1",
      recipientReference: "recipient-1",
      bankReference: "bank-1",
      operatorUserId: "user-1",
      environment: "sandbox" as const,
      destinationVersion: 1,
      amountCents: 300,
      feeCents: 200,
      netCents: 100,
      currency: "BRL" as const,
      policyVersion: "fee-v1",
    };
    const original = {
      correlation,
      snapshot: {
        intent: { siteId: "site-1", id: "withdrawal-1" },
        operatorUserId: "user-1",
        feeQuote: { expiresAt: new Date(+f.clock.value - 1).toISOString() },
      },
      consent: {
        snapshot: {
          scope: correlation,
          presentation: { payout: binding },
          preview: { expiresAt: new Date(+f.clock.value - 1).toISOString() },
        },
      },
    } as unknown as executionModule.OriginalWithdrawal;
    const fence: executionModule.DispatchFence = {
      operationId: "operation-1",
      attempts: 1,
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(+f.clock.value + 60_000).toISOString(),
    };
    const faults = { sqlLeaseValid: true, otherHeldCents: "50" };
    const queries: { sql: string; params: unknown[] }[] = [];
    f.execute.mockImplementation(async (statement) => {
      const query = new PgDialect().sqlToQuery(statement);
      queries.push(query);
      if (query.sql.startsWith("SELECT a.*"))
        return {
          rows: [
            {
              id: "account-1",
              site_id: "site-1",
              environment: "sandbox",
              provider: "ASAAS",
              isDemo: true,
              is_current: true,
              account_reference: "acct-1",
              recipient_reference: "recipient-1",
              operator_user_id: "user-1",
              credential_ciphertext: "credential",
            },
          ],
        };
      if (query.sql.includes('request_hash AS "requestHash"'))
        return {
          rows: [
            {
              requestHash: correlation.requestHash,
              requestSnapshot: structuredClone(original.snapshot),
              state: "PROCESSING",
              attempts: 1,
              leaseToken: fence.leaseToken,
              leaseOwner: fence.leaseOwner,
              leaseExpiresAt: fence.leaseExpiresAt,
            },
          ],
        };
      if (query.sql.includes("FROM receiving_setup_holder"))
        return {
          rows: [
            {
              id: "holder-1",
              holderUserId: "user-1",
              consentId: "holder-consent-1",
              consentVersion: receivingSetupConsentVersion,
              consentAt: f.clock.value,
            },
          ],
        };
      if (query.sql.includes("FROM receiving_pix_destination"))
        return {
          rows: [
            {
              id: "pix-1",
              version: 1,
              state: "PENDING",
              isCurrent: true,
              configuration: {
                key: { ciphertext: "destination" },
                review: { maskedCpfCnpj: "***.456.789-**" },
              },
            },
          ],
        };
      if (query.sql.includes('AS "otherHeldCents"'))
        return { rows: [{ otherHeldCents: faults.otherHeldCents }] };
      if (query.sql.includes("AS valid FROM financial_operation"))
        return { rows: [{ valid: faults.sqlLeaseValid }] };
      return { rows: [{ id: "site-1" }] };
    });
    const options = adapterFactory.mock.calls[0][0];
    const posting = postingFactory.mock.calls[0][1];
    if (posting.mode === "disabled" || !posting.ports)
      throw new Error("Missing posting ports");
    const command = {
      valueCents: 100,
      externalReference: "operation-1",
      pixAddressKey: "joao@example.test",
      pixAddressKeyType: "EMAIL" as const,
    };
    return {
      ...f,
      original,
      fence,
      options,
      posting: posting.ports,
      command,
      fees,
      balance,
      post,
      faults,
      queries,
    };
  }
  it.each(["success", "candidateFailure"] as const)(
    "publishes native authorization evidence in the same dispatch transaction: %s",
    async (kind) => {
      const events: string[] = [];
      const record = vi.fn(async () => {
        events.push("candidate");
        if (kind === "candidateFailure")
          throw new Error("candidate persistence failed");
      });
      vi.spyOn(
        authorizationModule,
        "createAsaasWithdrawalAuthorization",
      ).mockReturnValue({
        recordCandidateInTransaction: record,
        receive: vi.fn(async () => ({ status: "REFUSED" as const })),
      });
      const f = nativeFixture(true);
      f.db.transaction.mockImplementation(async (work) => {
        events.push("begin");
        try {
          const result = await work({ execute: f.execute });
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      });
      f.post.mockImplementation(async () => {
        events.push("native");
        return { provider: "ASAAS" };
      });
      try {
        const client = await f.options.loadClient(f.original, f.fence);
        events.length = 0;
        if (kind === "success") await client.createPixTransfer(f.command);
        else
          await expect(client.createPixTransfer(f.command)).rejects.toThrow(
            "candidate persistence failed",
          );
        expect(events).toEqual([
          "begin",
          "native",
          "candidate",
          kind === "success" ? "commit" : "rollback",
        ]);
        expect(f.post).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledOnce();
        expect(record.mock.calls[0]).toEqual([
          { execute: f.execute },
          f.original,
          f.fence,
          { provider: "ASAAS" },
          {
            key: f.command.pixAddressKey,
            type: "EMAIL",
            reviewedMaskedCpfCnpj: "***.456.789-**",
          },
        ]);
      } finally {
        await f.composition.close();
      }
    },
  );
  it("checks native fees and balance before returning pre-arm authority", async () => {
    const f = nativeFixture();
    f.balance.mockResolvedValue({ ...(await f.balance()), balanceCents: 349 });
    f.balance.mockClear();
    try {
      await expect(
        f.posting.loadDispatchAuthorityInTransaction(
          { execute: f.execute } as never,
          f.original,
          {
            actor: {
              siteId: "site-1",
              userId: "user-1",
              sessionId: "session-1",
            },
          } as never,
          f.clock.value,
        ),
      ).rejects.toThrow();
      expect(f.fees).toHaveBeenCalledOnce();
      expect(f.balance).toHaveBeenCalledOnce();
      expect(f.post).not.toHaveBeenCalled();
      const holds = f.queries.find((q) =>
        q.sql.includes('AS "otherHeldCents"'),
      );
      expect(holds?.sql).toContain("w.id<>");
      expect(holds?.params).toContain("withdrawal-1");
    } finally {
      await f.composition.close();
    }
  });
  it.each([
    "success",
    "fee",
    "balance",
    "sqlLease",
    "clockLease",
    "malformedHolds",
    "command",
  ])(
    "rechecks budget and current lease under the dispatch transaction: %s",
    async (kind) => {
      const f = nativeFixture();
      if (kind === "fee")
        f.fees.mockResolvedValue({
          ...(await f.fees()),
          fees: { transfer: { pix: { feeValue: "2.01" } } },
        });
      if (kind === "balance")
        f.balance.mockResolvedValue({
          ...(await f.balance()),
          balanceCents: 349,
        });
      if (kind === "sqlLease") f.faults.sqlLeaseValid = false;
      if (kind === "malformedHolds") f.faults.otherHeldCents = "1.5";
      if (kind === "command") f.command.valueCents = 101;
      if (kind === "clockLease")
        f.balance.mockImplementation(async () => {
          f.clock.value = new Date(f.fence.leaseExpiresAt);
          return {
            source: "provider",
            provider: "ASAAS",
            siteId: "site-1",
            accountBindingId: "account-1",
            accountReference: "acct-1",
            environment: "sandbox",
            currency: "BRL",
            observedAt: f.clock.value,
            balanceCents: 350,
          };
        });
      f.fees.mockClear();
      f.balance.mockClear();
      try {
        const client = await f.options.loadClient(f.original, f.fence);
        if (kind === "success") {
          await client.createPixTransfer(f.command);
          expect(f.post).toHaveBeenCalledOnce();
          const holds = f.queries.find((q) =>
            q.sql.includes('AS "otherHeldCents"'),
          );
          expect(holds?.sql).toContain("w.id<>");
          expect(holds?.params).toContain("withdrawal-1");
          expect(f.fees).toHaveBeenCalledOnce();
          expect(f.balance).toHaveBeenCalledOnce();
          const leaseIndex = f.queries.findIndex((q) =>
            q.sql.includes("AS valid FROM financial_operation"),
          );
          expect(leaseIndex).toBeGreaterThan(
            f.queries.findIndex((q) => q.sql.includes('AS "otherHeldCents"')),
          );
        } else {
          await expect(client.createPixTransfer(f.command)).rejects.toThrow();
          expect(f.post).not.toHaveBeenCalled();
        }
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        await f.composition.close();
      }
    },
  );
});

describe("withdrawal callback current holder access", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["revoked", "inactive"] as const)(
    "denies %s access before checking or locking monetary rows",
    async (kind) => {
      const factory = vi.spyOn(
        authorizationModule,
        "createAsaasWithdrawalAuthorization",
      );
      const f = enabledFixture(undefined, true);
      const statements: string[] = [];
      f.execute.mockImplementation(async (statement) => {
        const query = new PgDialect().sqlToQuery(statement);
        statements.push(query.sql);
        if (query.sql.startsWith("SELECT a.*"))
          return {
            rows: [
              {
                id: "account-1",
                site_id: "site-1",
                environment: "sandbox",
                provider: "ASAAS",
                isDemo: true,
                is_current: true,
                account_reference: "acct-1",
                recipient_reference: "recipient-1",
                operator_user_id: "user-1",
              },
            ],
          };
        if (query.sql.includes('FROM "user" u'))
          return {
            rows: [
              {
                user_id: "user-1",
                account_role: "SITE_ADMIN",
                account_state: kind === "inactive" ? "INACTIVE" : "ACTIVE",
                site_id: "site-1",
                membership_id: "membership-1",
                membership_user_id: "user-1",
                membership_role: "SITE_ADMIN",
                revoked_at: kind === "revoked" ? f.clock.value : null,
              },
            ],
          };
        if (query.sql.includes("FROM site"))
          return { rows: [{ id: "site-1" }] };
        return { rows: [] };
      });
      try {
        const verify = factory.mock.calls[0][1].verifyConsentInTransaction;
        await expect(
          verify(
            { execute: f.execute } as never,
            {
              correlation: {
                siteId: "site-1",
                accountId: "account-1",
                accountReference: "acct-1",
                operatorUserId: "user-1",
              },
            } as never,
          ),
        ).rejects.toThrow();
        expect(statements[0]).toContain("FROM site");
        expect(statements[0]).toContain("FOR UPDATE");
        expect(statements.some((s) => s.includes('FROM "user" u'))).toBe(true);
        expect(
          statements.some((s) => s.includes("FROM financial_operation")),
        ).toBe(false);
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        await f.composition.close();
      }
    },
  );
});

it("propagates the exact showcase policy to every withdrawal factory without changing provider mode", async () => {
  const service = vi.spyOn(
    reservationModule,
    "createWithdrawalReservationService",
  );
  const reservation = vi.spyOn(
    withdrawalRepository,
    "createWithdrawalReservationRepository",
  );
  const posting = vi.spyOn(postingModule, "createWithdrawalPostingRepository");
  const reader = vi.spyOn(
    storedAccountModule,
    "createAsaasStoredAccountReader",
  );
  const f = enabledFixture(undefined, false, true);
  try {
    for (const factory of [service, reservation, posting, reader])
      expect(
        factory.mock.calls.at(-1)?.[factory === service ? 0 : 1],
      ).toMatchObject({
        mode: "live",
        applicationEnvironment: "production",
        liveDemoSiteId: "demo-wedding",
      });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    await f.composition.close();
    service.mockRestore();
    reservation.mockRestore();
    posting.mockRestore();
    reader.mockRestore();
  }
});
