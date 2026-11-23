import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { describeUnavailable } from "./observability";
import { PAGARME_WITHDRAWAL_POLICY_VERSION } from "./pagarmeWithdrawalClient";
import * as receivingRepositoryModule from "./receivingRepository";
import {
  createWithdrawalComposition,
  quotePagarmeWithdrawalFee,
  verifyPagarmeWithdrawalDispatchBudget,
} from "./withdrawalComposition";
import type { OriginalWithdrawal } from "./withdrawalExecution";
import * as postingModule from "./withdrawalPostingRepository";
import * as reservationModule from "./withdrawalReservations";

const now = new Date("2026-11-18T12:00:00.000Z");
const recipient = "rp_fixtureRecipient01";
const config: Extract<GiftPaymentConfig, { mode: "sandbox" | "live" }> = {
  mode: "sandbox",
  providerMode: "test",
  applicationEnvironment: "test",
  secretKey: "sk_test_fixture",
  platformRecipientId: "rp_platform01",
  webhookBasicUser: "webhook-user",
  webhookCredentialsHash: "a".repeat(64),
};
const scope = {
  siteId: "site-1",
  accountId: "account-1",
  accountReference: recipient,
  environment: "sandbox" as const,
  bankReference: "ba_fixtureBankAcct01",
  destinationVersion: 1,
  amountCents: 10_000,
  currency: "BRL" as const,
};
const balanceFixture = readFileSync(
  new URL("./__fixtures__/pagarme/recipient-balance.json", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pagar.me withdrawal fee quote", () => {
  it("quotes the fixed fee with the recipient net for a sandbox withdrawal", () => {
    expect(quotePagarmeWithdrawalFee(scope, now)).toEqual({
      ...scope,
      feeCents: 367,
      feeSemantics: "MAXIMUM",
      policyVersion: PAGARME_WITHDRAWAL_POLICY_VERSION,
      provenance: "provider",
      verification: "verified",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    });
  });

  it("keeps the live gross budget semantics", () => {
    expect(
      quotePagarmeWithdrawalFee({ ...scope, environment: "live" }, now),
    ).toMatchObject({
      feeCents: 367,
      feeSemantics: "MAXIMUM_WITH_MINIMUM_NET",
    });
  });

  it.each([1, 366, 367])(
    "rejects a %i cent amount that does not exceed the fee",
    (amountCents) => {
      expect(() =>
        quotePagarmeWithdrawalFee({ ...scope, amountCents }, now),
      ).toThrow(
        expect.objectContaining({ status: 400, code: "WITHDRAWAL_INVALID" }),
      );
    },
  );

  it("accepts the smallest amount with a positive net transfer", () => {
    expect(
      quotePagarmeWithdrawalFee({ ...scope, amountCents: 368 }, now).feeCents,
    ).toBe(367);
  });
});

describe("Pagar.me dispatch budget", () => {
  const original = {
    correlation: {
      ...scope,
      amountCents: 10_000,
      feeCents: 367,
      netCents: 9_633,
      environment: "sandbox",
    },
  } as unknown as OriginalWithdrawal;
  const balance = (balanceCents: number, observedAt = now) => ({
    source: "provider" as const,
    provider: "PAGARME" as const,
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    accountReference: recipient,
    environment: "sandbox" as const,
    currency: "BRL" as const,
    observedAt,
    balanceCents,
  });

  it("requires the full gross amount plus other held commitments", () => {
    expect(() =>
      verifyPagarmeWithdrawalDispatchBudget(
        original,
        balance(15_000),
        5_000n,
        now,
      ),
    ).not.toThrow();
    expect(() =>
      verifyPagarmeWithdrawalDispatchBudget(
        original,
        balance(14_999),
        5_000n,
        now,
      ),
    ).toThrow();
  });

  it("rejects a stale or foreign balance", () => {
    expect(() =>
      verifyPagarmeWithdrawalDispatchBudget(
        original,
        balance(20_000, new Date(now.getTime() - 60_001)),
        0n,
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyPagarmeWithdrawalDispatchBudget(
        original,
        { ...balance(20_000), accountReference: "rp_other" },
        0n,
        now,
      ),
    ).toThrow();
  });
});

describe("withdrawal composition", () => {
  it("exposes no ports or provider calls when payments are disabled", async () => {
    const db = { execute: vi.fn(), transaction: vi.fn() };
    const disabled = createWithdrawalComposition(
      { mode: "disabled" },
      { db: db as never },
    );
    expect(disabled.service).toBeUndefined();
    expect(disabled.ports).toEqual({});
    await expect(disabled.reconcilePending()).resolves.toEqual({
      kind: "IDLE",
    });
    disabled.start();
    await disabled.close();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("refuses a sandbox configuration in production", () => {
    const composition = createWithdrawalComposition(
      { ...config, applicationEnvironment: "production" },
      { db: {} as never },
    );
    expect(composition.service).toBeUndefined();
  });

  it("reads the available Pagar.me balance and quotes the fixed fee", async () => {
    const created = vi.spyOn(
      reservationModule,
      "createWithdrawalReservationService",
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(balanceFixture, { status: 200 }),
    );
    const composition = createWithdrawalComposition(config, {
      db: { execute: vi.fn(), transaction: vi.fn() } as never,
      fetch,
      now: () => new Date(now),
    });
    try {
      expect(composition.ports.withdrawalReservation).toBe(composition.service);
      expect(composition.ports.finance).toBeDefined();
      expect(composition.ports.finance?.mode).toBe("sandbox");
      const options = created.mock.calls[0]?.[0];
      if (!options || options.mode === "disabled")
        throw new Error("Expected reservation options");
      await expect(options.balance.getBalance(scope)).resolves.toEqual({
        source: "provider",
        provider: "PAGARME",
        siteId: scope.siteId,
        accountBindingId: scope.accountId,
        accountReference: recipient,
        environment: "sandbox",
        currency: "BRL",
        observedAt: now,
        balanceCents: 25_000,
      });
      expect(String(fetch.mock.calls[0]?.[0])).toMatch(
        new RegExp(`/recipients/${recipient}/balance$`),
      );
      await expect(
        options.feeQuotes.quoteWithdrawal(scope),
      ).resolves.toMatchObject({ feeCents: 367 });
    } finally {
      await composition.close();
    }
  });

  it("does not read a balance for the platform recipient", async () => {
    const created = vi.spyOn(
      reservationModule,
      "createWithdrawalReservationService",
    );
    const fetch = vi.fn<typeof globalThis.fetch>();
    const composition = createWithdrawalComposition(config, {
      db: { execute: vi.fn(), transaction: vi.fn() } as never,
      fetch,
      now: () => new Date(now),
    });
    try {
      const options = created.mock.calls[0]?.[0];
      if (!options || options.mode === "disabled")
        throw new Error("Expected reservation options");
      await expect(
        options.balance.getBalance({
          ...scope,
          accountReference: config.platformRecipientId,
        }),
      ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await composition.close();
    }
  });

  it("owns and stops its recovery worker", async () => {
    const loop = {
      start: vi.fn(async () => {}),
      wake: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const createWorkerLoop = vi.fn(() => loop);
    const composition = createWithdrawalComposition(config, {
      db: { execute: vi.fn(), transaction: vi.fn() } as never,
      createWorkerLoop,
    });
    composition.start();
    composition.start();
    expect(loop.start).toHaveBeenCalledOnce();
    await composition.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(() => composition.start()).toThrow();
  });
});

function emptyWithdrawalHistory(siteId = "site-1") {
  return {
    rows: [
      {
        id: null,
        siteId,
        amountCents: null,
        feeCents: null,
        netCents: null,
        currency: null,
        destinationVersion: null,
        state: null,
        createdAt: null,
        updatedAt: null,
        mode: null,
        accountMatches: false,
      },
    ],
  };
}

describe("withdrawal history ports", () => {
  it.each(["sandbox", "live"] as const)(
    "reads actual empty withdrawal history without a receiving account in %s mode",
    async (mode) => {
      const execute = vi.fn(async (_query: SQL) => emptyWithdrawalHistory());
      const fetch = vi.fn<typeof globalThis.fetch>();
      const composition = createWithdrawalComposition(
        mode === "live"
          ? {
              ...config,
              mode,
              providerMode: "live",
              applicationEnvironment: "production",
              secretKey: "sk_live_fixture",
            }
          : config,
        { db: { execute, transaction: vi.fn() } as never, fetch },
      );
      await expect(
        composition.ports.finance?.listWithdrawals?.("site-1"),
      ).resolves.toEqual([]);
      expect(execute).toHaveBeenCalledOnce();
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(query.sql).toContain('LEFT JOIN "receiving_account" a');
      expect(query.params).toEqual([mode, "site-1", mode, []]);
      expect(fetch).not.toHaveBeenCalled();
      await composition.close();
    },
  );

  it("preserves stored withdrawal history site validation", async () => {
    const composition = createWithdrawalComposition(config, {
      db: {
        execute: vi.fn(async () => emptyWithdrawalHistory("another-site")),
        transaction: vi.fn(),
      } as never,
    });
    await expect(
      composition.ports.finance?.listWithdrawals?.("site-1"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
    await composition.close();
  });

  it("drains withdrawal history reads before closing and rejects new reads after close", async () => {
    let release = () => {};
    const query = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await query;
      return emptyWithdrawalHistory();
    });
    const composition = createWithdrawalComposition(config, {
      db: { execute, transaction: vi.fn() } as never,
    });
    const reading = composition.ports.finance?.listWithdrawals?.("site-1");
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    let closed = false;
    const closing = composition.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      composition.ports.finance?.listWithdrawals?.("site-1"),
    ).rejects.toThrow("Withdrawal composition closed");
    release();
    await expect(reading).resolves.toEqual([]);
    await closing;
    expect(closed).toBe(true);
  });
});

describe("withdrawal unavailable reasons", () => {
  // Synthetic personal data stored in rows; none may reach the diagnosis.
  const personal = {
    name: "Maria Ficticia Souza",
    email: "maria.ficticia@example.test",
    document: "123.456.789-09",
    bank: scope.bankReference,
    recipient,
  };
  function accountRow(overrides: Record<string, unknown> = {}) {
    return {
      id: scope.accountId,
      site_id: scope.siteId,
      environment: "sandbox",
      provider: "PAGARME",
      account_reference: recipient,
      recipient_reference: recipient,
      operator_user_id: "operator-one",
      is_current: true,
      isDemo: true,
      holder_name: personal.name,
      holder_email: personal.email,
      holder_document: personal.document,
      ...overrides,
    };
  }
  function harness(results: { rows: unknown[] }[]) {
    const execute = vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error("unexpected synthetic query");
      return next;
    });
    const tx = { execute };
    const db = {
      execute: vi.fn(),
      transaction: vi.fn(async (run: (value: unknown) => unknown) => run(tx)),
    };
    const reservation = vi.spyOn(
      reservationModule,
      "createWithdrawalReservationService",
    );
    const posting = vi.spyOn(
      postingModule,
      "createWithdrawalPostingRepository",
    );
    const composition = createWithdrawalComposition(config, {
      db: db as never,
      now: () => new Date(now),
      fetch: vi.fn<typeof globalThis.fetch>(),
    });
    const options = reservation.mock.calls[0]?.[0];
    if (!options || options.mode === "disabled")
      throw new Error("Expected reservation options");
    const postingOptions = posting.mock.calls[0]?.[1];
    const ports =
      postingOptions && "ports" in postingOptions
        ? postingOptions.ports
        : undefined;
    if (!ports) throw new Error("Expected posting ports");
    return { composition, options, ports, tx };
  }
  function loaded(binding: Record<string, unknown> = {}) {
    vi.spyOn(
      receivingRepositoryModule,
      "loadReceivingContextInTransaction",
    ).mockResolvedValue({
      isDemo: true,
      providerBinding: {
        accountReference: recipient,
        recipientReference: recipient,
        bankReference: personal.bank,
        destinationVersion: 1,
        ...binding,
      },
    } as never);
  }
  async function reasonOf(promise: Promise<unknown>) {
    const error = await promise.then(
      () => {
        throw new Error("Expected an unavailable read");
      },
      (value: unknown) => value,
    );
    expect(error).toMatchObject({
      status: 503,
      code: "WITHDRAWAL_UNAVAILABLE",
    });
    const described = describeUnavailable(error);
    const serialized = JSON.stringify(described);
    for (const value of Object.values(personal))
      expect(serialized).not.toContain(value);
    return described;
  }

  it.each([
    [0, []],
    [2, [accountRow(), accountRow({ id: "account-2" })]],
  ])(
    "labels %i current account rows as a row count mismatch",
    async (count, rows) => {
      loaded();
      const v = harness([{ rows }]);
      try {
        expect(await reasonOf(v.options.loadContext("site-1"))).toMatchObject({
          reason: "row_count_mismatch:current_account",
          count,
        });
      } finally {
        await v.composition.close();
      }
    },
  );

  it("labels a current destination without its stored reference", async () => {
    loaded({ bankReference: null });
    const v = harness([{ rows: [accountRow()] }]);
    try {
      expect(await reasonOf(v.options.loadContext("site-1"))).toMatchObject({
        reason: "destination_missing_reference",
      });
    } finally {
      await v.composition.close();
    }
  });

  it("labels an account that is no longer the site's current one", async () => {
    loaded();
    const v = harness([{ rows: [accountRow({ is_current: false })] }]);
    try {
      expect(await reasonOf(v.options.loadContext("site-1"))).toMatchObject({
        reason: "account_not_current",
      });
    } finally {
      await v.composition.close();
    }
  });

  it("labels a holder who is not the account operator", async () => {
    const v = harness([
      { rows: [accountRow()] },
      {
        rows: [
          {
            id: "holder-1",
            holderUserId: "holder-two",
            consentId: "consent-1",
            consentVersion: "any",
            consentAt: now,
            holderName: personal.name,
            holderDocument: personal.document,
          },
        ],
      },
    ]);
    try {
      expect(
        await reasonOf(
          v.ports.loadOriginalHolderConsentInTransaction(
            v.tx as never,
            {
              intent: { siteId: scope.siteId },
              accountId: scope.accountId,
              accountReference: recipient,
              operatorUserId: "operator-one",
            } as never,
            { previewHash: "a".repeat(64) } as never,
          ),
        ),
      ).toMatchObject({ reason: "holder_operator_mismatch" });
    } finally {
      await v.composition.close();
    }
  });
});
