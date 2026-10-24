import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { ReceivingTransaction } from "./receivingRepository";
import type {
  WithdrawalFeeScope,
  WithdrawalPresentationScope,
} from "./withdrawalReservations";
import {
  createWithdrawalStoredPresentationLoader,
  type WithdrawalStoredPresentationOptions,
} from "./withdrawalStoredPresentation";

const instant = "2026-10-12T13:00:00.000Z";
const scope: WithdrawalPresentationScope = {
  siteId: "site-1",
  accountId: "account-1",
  accountReference: "acct_1",
  environment: "live",
  bankReference: "bank_1",
  destinationVersion: 3,
};
const moneyScope: WithdrawalFeeScope = {
  ...scope,
  amountCents: 10_000,
  currency: "BRL",
};

function fixture() {
  const row: Record<string, unknown> = {
    siteId: "site-1",
    isDemo: false,
    accountId: "account-1",
    environment: "live",
    provider: "ASAAS",
    operatorUserId: "user-1",
    operatorReference: "operator_1",
    accountReference: "acct_1",
    recipientReference: "recipient_1",
    accountIsCurrent: true,
    accountState: "APPROVED",
    accountReceiving: true,
    accountWithdrawal: true,
    accountCommercial: true,
    accountObservedAt: "2026-10-12T12:59:30.000001Z",
    destinationId: "destination-1",
    destinationVersion: 3,
    bankReference: "bank_1",
    maskedDestination: "Banco **** 1234",
    destinationIsCurrent: true,
    destinationBankState: "VERIFIED",
    profileUserId: "user-1",
    profileRole: "SITE_ADMIN",
    profileState: "ACTIVE",
    operatorDisplayName: "Ana Silva",
    operatorProfileUpdatedAt: "2026-01-01T10:00:00.123456Z",
    evidenceId: "evidence-1",
    evidenceSiteId: "site-1",
    evidenceAccountId: "account-1",
    evidenceEnvironment: "live",
    evidenceDestinationVersion: 3,
    evidenceOperatorReference: "operator_1",
    evidenceAccountReference: "acct_1",
    evidenceRecipientReference: "recipient_1",
    evidenceBankReference: "bank_1",
    evidenceVerification: "VERIFIED",
    evidenceProvenance: "PROVIDER",
    verificationReference: "verification_1",
    evidenceAccountState: "APPROVED",
    evidenceBankState: "VERIFIED",
    evidenceReceiving: true,
    evidenceWithdrawal: true,
    evidenceCommercial: true,
    evidenceObservedAt: "2026-10-12T12:59:29.123456Z",
    bankObservedAt: "2026-10-12T12:59:00.000001Z",
    evidenceCreatedAt: "2026-10-12T12:59:31.000002Z",
  };
  const rows = [row];
  const clock = vi.fn(() => new Date(instant));
  const options: Exclude<
    WithdrawalStoredPresentationOptions,
    { mode: "disabled" }
  > = {
    mode: "live",
    applicationEnvironment: "production",
    freshnessMs: 60_000,
    now: clock,
  };
  const execute = vi.fn(async (_query: SQL) => ({ rows }));
  const tx = { execute } as unknown as ReceivingTransaction;
  const load = () => createWithdrawalStoredPresentationLoader(options);
  return { row, rows, clock, options, execute, tx, load };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected real transport");
  });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("stored withdrawal presentation", () => {
  it("returns exactly nineteen stored fields without creating monetary terms", async () => {
    const f = fixture();
    const result = await f.load()(f.tx, scope);
    expect(result).toMatchObject({
      ...scope,
      source: "stored",
      verification: "verified",
      provenance: "provider",
      operatorUserId: "user-1",
      recipientReference: "recipient_1",
      destinationId: "destination-1",
      evidenceId: "evidence-1",
      verificationReference: "verification_1",
      maskedDestination: "Banco **** 1234",
      operatorDisplayName: "Ana Silva",
    });
    expect(Object.keys(result ?? {})).toHaveLength(19);
    expect(result).not.toHaveProperty("amountCents");
    expect(result).not.toHaveProperty("currency");
    expect(result).not.toHaveProperty("feeCents");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.clock).toHaveBeenCalledTimes(2);
  });

  it("returns exactly twenty-one fields for the supplied full scope", async () => {
    const f = fixture();
    const result = await f.load()(f.tx, moneyScope);
    expect(result).toMatchObject(moneyScope);
    expect(Object.keys(result ?? {})).toHaveLength(21);
    expect(result).not.toHaveProperty("netCents");
  });

  it("preserves exact stored timestamp precision and an old current profile", async () => {
    const f = fixture();
    const result = await f.load()(f.tx, scope);
    for (const key of [
      "evidenceObservedAt",
      "bankObservedAt",
      "operatorProfileUpdatedAt",
    ] as const) {
      expect(result?.[key]).toBeInstanceOf(Date);
      expect(databaseTimestampEpochMicroseconds(result?.[key])).toBe(
        databaseTimestampEpochMicroseconds(f.row[key]),
      );
    }
  });

  it("validates the existing user role domain without granting membership", async () => {
    const f = fixture();
    f.row.profileRole = "SITE_ASSISTANT";
    expect(await f.load()(f.tx, scope)).toMatchObject({
      operatorUserId: "user-1",
    });
    expect(await f.load()(f.tx, scope)).not.toHaveProperty("membershipRole");
  });

  it.each([
    ["siteId", "other-site"],
    ["accountId", "other-account"],
    ["environment", "sandbox"],
    ["provider", "OTHER"],
    ["accountReference", "other-account"],
    ["bankReference", "other-bank"],
    ["destinationVersion", 4],
    ["profileUserId", "other-user"],
    ["evidenceSiteId", "other-site"],
    ["evidenceAccountId", "other-account"],
    ["evidenceEnvironment", "sandbox"],
    ["evidenceDestinationVersion", 4],
    ["evidenceOperatorReference", "other-operator"],
    ["evidenceAccountReference", "other-account"],
    ["evidenceRecipientReference", "other-recipient"],
    ["evidenceBankReference", "other-bank"],
  ])("rejects a foreign stored %s", async (key, value) => {
    const f = fixture();
    f.row[key as string] = value;
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it.each([
    ["accountIsCurrent", false],
    ["destinationIsCurrent", false],
    ["accountState", "SUSPENDED"],
    ["evidenceAccountState", "UNDER_REVIEW"],
    ["destinationBankState", "UNVERIFIED"],
    ["evidenceBankState", "REJECTED"],
    ["evidenceVerification", "UNVERIFIED"],
    ["evidenceProvenance", "UNKNOWN"],
    ["accountReceiving", false],
    ["accountWithdrawal", false],
    ["accountCommercial", false],
    ["evidenceReceiving", false],
    ["evidenceWithdrawal", false],
    ["evidenceCommercial", false],
    ["profileState", "DISABLED"],
    ["profileRole", "OWNER"],
    ["operatorReference", ""],
    ["recipientReference", ""],
    ["verificationReference", null],
    ["destinationId", ""],
    ["evidenceId", ""],
  ])("keeps unsupported %s unavailable", async (key, value) => {
    const f = fixture();
    f.row[key as string] = value;
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it.each([
    null,
    "",
    "12345678901",
    "Banco 1234",
    "**** 123456",
    "**** 1234\n",
  ])(
    "does not fabricate or sanitize an unsafe stored mask %j",
    async (mask) => {
      const f = fixture();
      f.row.maskedDestination = mask;
      expect(await f.load()(f.tx, scope)).toBeNull();
    },
  );

  it.each(["", " Ana Silva", "Ana Silva ", "Ana\nSilva", "A".repeat(121)])(
    "rejects an invalid current profile %j",
    async (name) => {
      const f = fixture();
      f.row.operatorDisplayName = name;
      expect(await f.load()(f.tx, scope)).toBeNull();
    },
  );

  it.each(["accountObservedAt", "evidenceObservedAt", "bankObservedAt"])(
    "checks %s independently at settlement",
    async (key) => {
      const f = fixture();
      f.row[key] = "2026-10-12T12:58:59.999999Z";
      expect(await f.load()(f.tx, scope)).toBeNull();
    },
  );

  it.each([
    "accountObservedAt",
    "evidenceObservedAt",
    "bankObservedAt",
    "operatorProfileUpdatedAt",
    "evidenceCreatedAt",
  ])("rejects future microseconds in %s", async (key) => {
    const f = fixture();
    f.row[key] = "2026-10-12T13:00:00.000001Z";
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it("does not renew bank proof with an account refresh", async () => {
    const f = fixture();
    f.row.accountObservedAt = instant;
    f.row.bankObservedAt = "2026-10-12T12:58:59.999999Z";
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it("rejects evidence observed after its creation", async () => {
    const f = fixture();
    f.row.evidenceCreatedAt = "2026-10-12T12:59:29.123455Z";
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it("accepts only the latest evidence and never falls back to older approval", async () => {
    const f = fixture();
    f.rows.push({
      ...f.row,
      evidenceId: "older-1",
      evidenceCreatedAt: "2026-10-12T12:59:30.000001Z",
    });
    f.row.evidenceVerification = "UNVERIFIED";
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it("accepts a strictly older scoped row without selecting it", async () => {
    const f = fixture();
    f.rows.push({
      ...f.row,
      evidenceId: "older-1",
      evidenceCreatedAt: "2026-10-12T12:59:31.000001Z",
      evidenceVerification: "UNVERIFIED",
    });
    expect(await f.load()(f.tx, scope)).toMatchObject({
      evidenceId: "evidence-1",
    });
  });

  it.each(["equal", "newer", "duplicate", "foreign", "excess"])(
    "rejects %s evidence cardinality or ordering",
    async (kind) => {
      const f = fixture();
      const older: Record<string, unknown> = {
        ...f.row,
        evidenceId: "older-1",
      };
      if (kind === "newer") older.evidenceCreatedAt = instant;
      if (kind === "duplicate") older.evidenceId = f.row.evidenceId;
      if (kind === "foreign") {
        older.evidenceCreatedAt = "2026-10-12T12:59:30.000000Z";
        older.accountId = "other-account";
      }
      f.rows.push(older);
      if (kind === "excess") f.rows.push({ ...older });
      expect(await f.load()(f.tx, scope)).toBeNull();
    },
  );

  it.each(["provider", "simulation"])(
    "allows stored demo sandbox %s only",
    async (provenance) => {
      const f = fixture();
      f.options.mode = "sandbox";
      f.options.applicationEnvironment = "development";
      f.row.isDemo = true;
      f.row.environment = "sandbox";
      f.row.evidenceEnvironment = "sandbox";
      f.row.evidenceProvenance = provenance.toUpperCase();
      expect(
        await f.load()(f.tx, { ...scope, environment: "sandbox" }),
      ).toMatchObject({ provenance });
    },
  );

  it.each(["non-demo", "live", "production"])(
    "denies simulation in %s",
    async (kind) => {
      const f = fixture();
      f.row.evidenceProvenance = "SIMULATION";
      f.row.isDemo = kind !== "non-demo";
      if (kind !== "live") {
        f.options.mode = "sandbox";
        f.row.environment = "sandbox";
        f.row.evidenceEnvironment = "sandbox";
      }
      if (kind !== "production")
        f.options.applicationEnvironment = "development";
      expect(
        await f.load()(f.tx, { ...scope, environment: f.options.mode }),
      ).toBeNull();
    },
  );

  it("rejects live demo even with provider provenance", async () => {
    const f = fixture();
    f.row.isDemo = true;
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it.each(["backward", "invalid", "expired"])(
    "rejects %s settlement clock",
    async (kind) => {
      const f = fixture();
      f.clock
        .mockReturnValueOnce(new Date(instant))
        .mockReturnValueOnce(
          new Date(
            kind === "backward"
              ? "2026-10-12T12:59:59.999Z"
              : kind === "expired"
                ? "2026-10-12T13:00:00.001Z"
                : "invalid",
          ),
        );
      expect(await f.load()(f.tx, scope)).toBeNull();
    },
  );

  it.each([
    { ...scope, amountCents: 100 },
    { ...scope, currency: "BRL" },
    { ...moneyScope, amountCents: 0 },
    { ...moneyScope, amountCents: 1.1 },
    { ...moneyScope, amountCents: 2_147_483_648 },
    { ...moneyScope, currency: "USD" },
    { ...scope, destinationVersion: 0 },
    { ...scope, proof: "not-accepted" },
    { ...scope, environment: "sandbox" },
  ])("rejects invalid scope before SELECT %j", async (input) => {
    const f = fixture();
    expect(await f.load()(f.tx, input as WithdrawalFeeScope)).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects scope accessors without invoking them", async () => {
    const f = fixture();
    const get = vi.fn(() => scope.accountId);
    const input = { ...scope };
    Object.defineProperty(input, "accountId", { get, enumerable: true });
    expect(await f.load()(f.tx, input)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["site.1", "site:1"])(
    "rejects noncanonical site %s before SELECT even with matching stored rows",
    async (siteId) => {
      const f = fixture();
      f.row.siteId = siteId;
      f.row.evidenceSiteId = siteId;
      expect(await f.load()(f.tx, { ...scope, siteId })).toBeNull();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "invalid-config", "accessor"])(
    "does no I/O for %s configuration",
    async (kind) => {
      const f = fixture();
      const get = vi.fn(() => 60_000);
      const options: unknown =
        kind === "disabled"
          ? { mode: "disabled" }
          : { ...f.options, freshnessMs: 0 };
      if (kind === "accessor")
        Object.defineProperty(options, "freshnessMs", {
          get,
          enumerable: true,
        });
      const load = createWithdrawalStoredPresentationLoader(
        options as WithdrawalStoredPresentationOptions,
      );
      expect(await load(f.tx, scope)).toBeNull();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.clock).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("captures scope and configuration before an asynchronous SELECT", async () => {
    const f = fixture();
    let release: (value: { rows: Record<string, unknown>[] }) => void =
      () => {};
    const selected = new Promise<{ rows: Record<string, unknown>[] }>(
      (resolve) => {
        release = resolve;
      },
    );
    f.execute.mockImplementationOnce(() => selected);
    const input = { ...scope };
    const operation = f.load()(f.tx, input);
    input.accountId = "other-account";
    input.bankReference = "other-bank";
    f.options.mode = "sandbox";
    f.options.freshnessMs = 1;
    release({ rows: f.rows });
    expect(await operation).toMatchObject(scope);
  });

  it("copies precise stored dates and row data before the settlement callback", async () => {
    const f = fixture();
    const original = readDatabaseTimestamp(f.row.evidenceObservedAt);
    const expected = databaseTimestampEpochMicroseconds(original);
    f.row.evidenceObservedAt = original;
    f.clock
      .mockReturnValueOnce(new Date(instant))
      .mockImplementationOnce(() => {
        original.setTime(0);
        f.row.maskedDestination = "unsafe bank data";
        return new Date(instant);
      });
    const result = await f.load()(f.tx, scope);
    expect(result).toMatchObject({ maskedDestination: "Banco **** 1234" });
    expect(databaseTimestampEpochMicroseconds(result?.evidenceObservedAt)).toBe(
      expected,
    );
  });

  it("returns null for missing, malformed or throwing SELECT results", async () => {
    const f = fixture();
    f.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("Private SQL details"));
    expect(await f.load()(f.tx, scope)).toBeNull();
    expect(await f.load()(f.tx, scope)).toBeNull();
    f.row.bankObservedAt = "malformed";
    expect(await f.load()(f.tx, scope)).toBeNull();
  });

  it("rejects row accessors without invoking them", async () => {
    const f = fixture();
    const get = vi.fn(() => "Banco **** 1234");
    Object.defineProperty(f.row, "maskedDestination", {
      get,
      enumerable: true,
    });
    expect(await f.load()(f.tx, scope)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not coerce corrupted configuration into a supported environment", async () => {
    const f = fixture();
    const conversionSpy = vi.fn(() => "production");
    const options = {
      ...f.options,
      applicationEnvironment: { toString: conversionSpy },
    };
    const load = createWithdrawalStoredPresentationLoader(
      options as unknown as WithdrawalStoredPresentationOptions,
    );
    expect(await load(f.tx, scope)).toBeNull();
    expect(conversionSpy).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not coerce corrupted role data into the existing role domain", async () => {
    const f = fixture();
    const conversionSpy = vi.fn(() => "SITE_ADMIN");
    f.row.profileRole = { toString: conversionSpy };
    expect(await f.load()(f.tx, scope)).toBeNull();
    expect(conversionSpy).not.toHaveBeenCalled();
  });

  it("uses one parameterized bounded SELECT without locks or sensitive projection", async () => {
    const f = fixture();
    expect(await f.load()(f.tx, moneyScope)).not.toBeNull();
    const query = new PgDialect().sqlToQuery(f.execute.mock.calls[0][0]);
    expect(query.sql.trim()).toMatch(/^SELECT\b/i);
    expect(query.sql).toMatch(/LATERAL/i);
    expect(query.sql).toMatch(/ORDER BY ev\.created_at DESC,\s*ev\.id DESC/i);
    expect(query.sql).toMatch(/LIMIT 2/i);
    expect(query.sql.trim()).toMatch(
      /ORDER BY e\.created_at DESC,\s*e\.id DESC LIMIT 3$/i,
    );
    expect(query.sql).not.toMatch(
      /FOR (UPDATE|SHARE)|advisory|\b(INSERT|UPDATE|DELETE)\b|credential|webhook_token|email|tax_id|bank_number|balance|proof|session/i,
    );
    expect(query.params).toEqual(
      expect.arrayContaining([
        scope.siteId,
        scope.accountId,
        scope.accountReference,
        scope.bankReference,
        scope.destinationVersion,
        scope.environment,
      ]),
    );
    expect(query.params).not.toContain(moneyScope.amountCents);
    expect(query.params).not.toContain(moneyScope.currency);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});

describe("live showcase stored withdrawal presentation", () => {
  it("retains actual demo identity while accepting fresh native facts for the exact configured site", async () => {
    const f = fixture();
    f.row.isDemo = true;
    const loader = createWithdrawalStoredPresentationLoader({
      ...f.options,
      liveDemoSiteId: scope.siteId,
    });
    expect(await loader(f.tx, scope)).toMatchObject({
      siteId: scope.siteId,
      provenance: "provider",
    });
    expect(f.row.isDemo).toBe(true);
  });
  it.each([undefined, "other-site"])(
    "denies a demo live presentation with opt-in %s",
    async (liveDemoSiteId) => {
      const f = fixture();
      f.row.isDemo = true;
      const loader = createWithdrawalStoredPresentationLoader({
        ...f.options,
        liveDemoSiteId,
      });
      expect(await loader(f.tx, scope)).toBeNull();
    },
  );
  it("never accepts simulated live evidence after showcase authorization", async () => {
    const f = fixture();
    f.row.isDemo = true;
    f.row.evidenceProvenance = "SIMULATION";
    expect(
      await createWithdrawalStoredPresentationLoader({
        ...f.options,
        liveDemoSiteId: scope.siteId,
      })(f.tx, scope),
    ).toBeNull();
  });
});
