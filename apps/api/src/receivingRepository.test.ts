import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { evaluateReceivingReadiness } from "./receivingReadiness";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
  type ReceivingDatabase,
  type ReceivingRepositoryOptions,
  type ReceivingTransaction,
  readReceivingReadiness,
} from "./receivingRepository";

const now = new Date("2026-10-12T12:00:00.000Z");
const siteId = "site-1";
const options: ReceivingRepositoryOptions = {
  mode: "live",
  applicationEnvironment: "production",
  freshnessMs: 60_000,
  now: () => new Date(now),
};
const account = {
  id: "account-1",
  siteId,
  environment: "live",
  provider: "ASAAS",
  operatorUserId: "user-1",
  operatorReference: "operator-1",
  accountReference: "remote-account-1",
  recipientReference: "recipient-1",
  providerAccountState: "APPROVED",
  receivingCapability: true,
  withdrawalCapability: true,
  commercialEnabled: true,
  isCurrent: true,
  observedAt: new Date(now.getTime() - 1_000),
};
const destination = {
  id: "destination-1",
  siteId,
  accountId: account.id,
  environment: "live",
  version: 3,
  bankReference: "bank-1",
  bankState: "VERIFIED",
  isCurrent: true,
};
const evidence = {
  id: "evidence-1",
  siteId,
  accountId: account.id,
  environment: "live",
  destinationVersion: 3,
  operatorReference: account.operatorReference,
  accountReference: account.accountReference,
  recipientReference: account.recipientReference,
  bankReference: destination.bankReference,
  verificationStatus: "VERIFIED",
  verificationReference: "verification-1",
  provenance: "PROVIDER",
  providerAccountState: "APPROVED",
  bankState: "VERIFIED",
  receivingCapability: true,
  withdrawalCapability: true,
  commercialEnabled: true,
  observedAt: new Date(now.getTime() - 2_000),
  bankObservedAt: new Date(now.getTime() - 3_000),
  createdAt: new Date(now.getTime() - 1_000),
};

function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

// A query-only client exercises Drizzle SQL and decoding without a connection.
function fixture(
  overrides: Partial<
    Record<
      | "site"
      | "receiving_account"
      | "receiving_destination"
      | "receiving_verification_evidence",
      Record<string, unknown>[]
    >
  > = {},
  failedTable?: string,
  unscopedResults = false,
) {
  const records: Record<string, Record<string, unknown>[]> = {
    site: [{ id: siteId, isDemo: false }],
    receiving_account: [{ ...account }],
    receiving_destination: [{ ...destination }],
    receiving_verification_evidence: [{ ...evidence }],
    ...overrides,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      const table = sql.match(/from "([a-z_]+)"/i)?.[1];
      if (!table || !records[table]) throw new Error("Unexpected query");
      if (table === failedTable)
        throw new Error("postgres credential-secret-123");
      let rows = records[table].filter(
        (row) =>
          unscopedResults ||
          [...sql.matchAll(/"([a-z_]+)" = \$(\d+)/g)].every(
            (match) =>
              row[camelCase(match[1])] === params[Number(match[2]) - 1],
          ),
      );
      const sort = sql.match(/order by (.*?) limit/i)?.[1];
      if (sort) {
        const columns = [...sort.matchAll(/"([a-z_]+)" (asc|desc)/gi)];
        rows = [...rows].sort((left, right) => {
          for (const [, column, direction] of columns) {
            const a = left[camelCase(column)];
            const b = right[camelCase(column)];
            const compared =
              a instanceof Date && b instanceof Date
                ? a.getTime() - b.getTime()
                : String(a).localeCompare(String(b));
            if (compared)
              return direction.toLowerCase() === "desc" ? -compared : compared;
          }
          return 0;
        });
      }
      const limit = sql.match(/limit \$(\d+)/i);
      if (limit) rows = rows.slice(0, Number(params[Number(limit[1]) - 1]));
      const columns = [
        ...(sql.match(/^select (.*?) from/i)?.[1] ?? "").matchAll(
          /"([a-z_]+)"/g,
        ),
      ].map((match) => camelCase(match[1]));
      return {
        rows: rows.map((row) =>
          columns.map((column) => {
            const value = row[column];
            return value instanceof Date ? value.toISOString() : value;
          }),
        ),
      };
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  return { db, queries, query };
}

describe("stored receiving context", () => {
  it("keeps the default and disabled modes closed without database reads", async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as ReceivingDatabase;
    expect(await loadReceivingContext(db, "site-1")).toBeNull();
    expect(await readReceivingReadiness(db, "site-1")).toEqual({
      siteId: "site-1",
      state: "NOT_CONFIGURED",
      reason: "NOT_CONFIGURED",
      observedAt: null,
      destinationVersion: null,
      catalogEligible: false,
      mode: "disabled",
    });
    expect(
      await loadReceivingContext(db, "site-1", {
        mode: "disabled",
        applicationEnvironment: "production",
        freshnessMs: 60_000,
      }),
    ).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("uses an existing write transaction without nesting or changing its isolation", async () => {
    const { db, queries } = fixture();
    const context = await db.transaction(
      async (tx) => {
        const nested = vi
          .spyOn(tx, "transaction")
          .mockRejectedValue(new Error("Nested transaction forbidden"));
        const result = await loadReceivingContextInTransaction(
          tx,
          siteId,
          options,
        );
        expect(nested).not.toHaveBeenCalled();
        return result;
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
    expect(context?.providerBinding?.accountReference).toBe(
      account.accountReference,
    );
    expect(
      context && evaluateReceivingReadiness({ ...context, siteId, now }),
    ).toMatchObject({ state: "READY" });
    expect(queries[0].sql).toBe(
      "begin isolation level read committed read write",
    );
    expect(queries.filter((entry) => /^begin/i.test(entry.sql))).toHaveLength(
      1,
    );
    expect(queries.filter((entry) => /^commit/i.test(entry.sql))).toHaveLength(
      1,
    );
    expect(
      queries.some((entry) =>
        /savepoint|set transaction|read only/i.test(entry.sql),
      ),
    ).toBe(false);
    const selects = queries.filter((entry) => /^select /i.test(entry.sql));
    expect(selects).toHaveLength(4);
    for (const entry of selects) {
      expect(entry.params).toContain(siteId);
      expect(entry.sql).not.toMatch(
        /select \*|credential|masked_descriptor|cpf|kyc|access_token|password/i,
      );
    }
  });

  it("keeps the transaction-bound reader disabled without querying its executor", async () => {
    const select = vi.fn();
    const transaction = vi.fn();
    const tx = { select, transaction } as unknown as ReceivingTransaction;
    expect(await loadReceivingContextInTransaction(tx, siteId)).toBeNull();
    expect(
      await loadReceivingContextInTransaction(tx, siteId, {
        ...options,
        mode: "disabled",
      }),
    ).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["unverified", "stale"])(
    "shares scoped newest-proof and freshness policy inside an existing transaction: %s",
    async (state) => {
      const { db } = fixture(
        state === "unverified"
          ? {
              receiving_verification_evidence: [
                { ...evidence },
                {
                  ...evidence,
                  id: "latest-evidence",
                  verificationStatus: "UNVERIFIED",
                  createdAt: new Date(now.getTime() - 500),
                },
              ],
            }
          : {
              receiving_account: [
                {
                  ...account,
                  observedAt: new Date(now.getTime() - options.freshnessMs - 1),
                },
              ],
            },
      );
      const context = await db.transaction((tx) =>
        loadReceivingContextInTransaction(tx, siteId, options),
      );
      expect(context?.providerBinding?.accountReference).toBe(
        account.accountReference,
      );
      expect(context).toEqual(await loadReceivingContext(db, siteId, options));
      expect(
        context && evaluateReceivingReadiness({ ...context, siteId, now }),
      ).toMatchObject({
        reason: "EVIDENCE_STALE",
        catalogEligible: false,
      });
      if (state === "unverified")
        expect(context?.evidence?.verification).toBe("unverified");
      else
        expect(context?.evidence?.observedAt).toEqual(
          new Date(now.getTime() - options.freshnessMs - 1),
        );
    },
  );

  it("reads only scoped stored proof in one repeatable read transaction", async () => {
    const { db, queries } = fixture();
    const context = await loadReceivingContext(db, siteId, options);
    expect(context?.providerBinding).toEqual({
      siteId,
      provider: "ASAAS",
      operatorReference: "operator-1",
      environment: "live",
      accountReference: "remote-account-1",
      recipientReference: "recipient-1",
      destinationVersion: 3,
      bankReference: "bank-1",
    });
    expect(context?.evidence?.observedAt).toEqual(evidence.observedAt);
    expect(context?.evidence?.bankObservedAt).toEqual(evidence.bankObservedAt);
    expect(await readReceivingReadiness(db, siteId, options)).toEqual({
      siteId,
      state: "READY",
      reason: null,
      observedAt: evidence.bankObservedAt.toISOString(),
      destinationVersion: 3,
      catalogEligible: true,
      mode: "live",
    });
    expect(queries[0].sql).toBe(
      "begin isolation level repeatable read read only",
    );
    const selects = queries.filter((entry) => /^select /i.test(entry.sql));
    expect(selects).toHaveLength(8);
    for (const entry of selects) {
      expect(entry.params).toContain(siteId);
      expect(entry.sql).not.toMatch(
        /select \*|credential|masked_descriptor|cpf|kyc|access_token|password/i,
      );
    }
    expect(
      selects.find((entry) => entry.sql.includes('from "receiving_account"'))
        ?.params,
    ).toEqual([siteId, "live", true, 1]);
    expect(
      selects.find((entry) =>
        entry.sql.includes('from "receiving_destination"'),
      )?.params,
    ).toEqual([siteId, account.id, "live", true, 1]);
    const proof = selects.find((entry) =>
      entry.sql.includes('from "receiving_verification_evidence"'),
    );
    expect(proof?.params).toEqual([
      siteId,
      account.id,
      "live",
      destination.version,
      2,
    ]);
    expect(proof?.sql).toMatch(
      /order by "receiving_verification_evidence"\."created_at" desc, "receiving_verification_evidence"\."id" desc/i,
    );
    expect(proof?.sql.split("where")[1].split("order by")[0]).not.toContain(
      "verification_status",
    );
  });

  it("requires the stored operator designation rather than a legacy remote reference alone", async () => {
    const { db } = fixture({
      receiving_account: [{ ...account, operatorUserId: null }],
    });
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      catalogEligible: false,
    });
  });

  it("does not convert missing provenance into simulation approval for a sandbox demo", async () => {
    const { db } = fixture({
      site: [{ id: siteId, isDemo: true }],
      receiving_account: [{ ...account, environment: "sandbox" }],
      receiving_destination: [{ ...destination, environment: "sandbox" }],
      receiving_verification_evidence: [
        { ...evidence, environment: "sandbox", provenance: null },
      ],
    });
    expect(
      await readReceivingReadiness(db, siteId, {
        ...options,
        mode: "sandbox",
        applicationEnvironment: "test",
      }),
    ).toMatchObject({ catalogEligible: false });
  });

  it.each([
    ["account", "observedAt"],
    ["proof", "observedAt"],
    ["proof", "bankObservedAt"],
  ])(
    "does not hide a future %s %s behind an older valid observation",
    async (source, column) => {
      const { db } = fixture(
        source === "account"
          ? {
              receiving_account: [
                { ...account, [column]: new Date(now.getTime() + 1) },
              ],
            }
          : {
              receiving_verification_evidence: [
                { ...evidence, [column]: new Date(now.getTime() + 1) },
              ],
            },
      );
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
      });
    },
  );

  it.each([
    ["site", { id: "other-site", isDemo: false }],
    ["receiving_account", { ...account, id: "" }],
    ["receiving_account", { ...account, isCurrent: false }],
    ["receiving_destination", { ...destination, accountId: "other-account" }],
    ["receiving_destination", { ...destination, siteId: "other-site" }],
    ["receiving_destination", { ...destination, environment: "sandbox" }],
    ["receiving_destination", { ...destination, isCurrent: false }],
    [
      "receiving_verification_evidence",
      { ...evidence, accountId: "other-account" },
    ],
  ] as const)(
    "fails closed when %s returns an inconsistent stored scope",
    async (table, row) => {
      const { db } = fixture({ [table]: [row] }, undefined, true);
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
      });
    },
  );

  it("sanitizes database failures without leaking the driver message or credentials", async () => {
    const { db, queries } = fixture({}, "receiving_account");
    let error: unknown;
    try {
      await readReceivingReadiness(db, siteId, options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(String(error)).not.toContain("credential-secret-123");
    expect(error).not.toHaveProperty("cause");
    expect(queries.at(-1)?.sql).toBe("rollback");
  });

  it.each([
    [{ providerAccountState: "SUSPENDED" }, "ACCOUNT_BLOCKED"],
    [{ providerAccountState: "UNDER_REVIEW" }, "ACCOUNT_UNDER_REVIEW"],
    [{ receivingCapability: false }, "CAPABILITY_UNAVAILABLE"],
    [{ withdrawalCapability: false }, "CAPABILITY_UNAVAILABLE"],
    [{ commercialEnabled: false }, "PROVIDER_DISABLED"],
  ])(
    "lets current account restrictions override an older approved proof: %j",
    async (restriction, reason) => {
      const { db } = fixture({
        receiving_account: [{ ...account, ...restriction }],
      });
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
        reason,
      });
    },
  );

  it.each(["PENDING", "UNVERIFIED"])(
    "requires current bank approval when the destination is %s",
    async (bankState) => {
      const { db } = fixture({
        receiving_destination: [{ ...destination, bankState }],
      });
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        state: "BANK_VALIDATION_PENDING",
        reason: "BANK_VERIFICATION_REQUIRED",
        catalogEligible: false,
      });
    },
  );

  it("lets the latest unverified proof supersede older verified evidence", async () => {
    const { db } = fixture({
      receiving_verification_evidence: [
        {
          ...evidence,
          id: "new-evidence",
          verificationStatus: "UNVERIFIED",
          createdAt: new Date(now.getTime() - 500),
        },
        { ...evidence },
      ],
    });
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      state: "BLOCKED",
      reason: "EVIDENCE_STALE",
      catalogEligible: false,
    });
  });

  it("does not infer chronological proof order from lexical IDs when creation times tie", async () => {
    const { db } = fixture({
      receiving_verification_evidence: [
        { ...evidence, id: "z-old-verified" },
        {
          ...evidence,
          id: "a-new-unverified",
          verificationStatus: "UNVERIFIED",
        },
      ],
    });
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      catalogEligible: false,
    });
  });

  it.each(["not-a-date", new Date(now.getTime() + 1)])(
    "denies evidence with invalid or future creation time %s",
    async (createdAt) => {
      const { db } = fixture({
        receiving_verification_evidence: [{ ...evidence, createdAt }],
      });
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
      });
    },
  );

  it("does not reuse evidence from the previous destination version", async () => {
    const { db } = fixture({
      receiving_destination: [
        { ...destination, isCurrent: false },
        {
          ...destination,
          id: "destination-2",
          version: 4,
          bankReference: "bank-2",
          bankState: "UNVERIFIED",
        },
      ],
    });
    const context = await loadReceivingContext(db, siteId, options);
    expect(context?.providerBinding?.destinationVersion).toBe(4);
    expect(context?.evidence).toBeNull();
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      destinationVersion: 4,
      catalogEligible: false,
    });
  });

  it.each([
    "site",
    "receiving_account",
    "receiving_destination",
    "receiving_verification_evidence",
  ] as const)(
    "requires the stored %s row without inventing approval",
    async (table) => {
      const { db } = fixture({ [table]: [] });
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
        observedAt: null,
      });
    },
  );

  it.each([
    ["account", "observedAt"],
    ["proof", "observedAt"],
    ["proof", "bankObservedAt"],
  ])("requires independent freshness for %s %s", async (source, column) => {
    const stale = new Date(now.getTime() - options.freshnessMs - 1);
    const { db } = fixture(
      source === "account"
        ? { receiving_account: [{ ...account, [column]: stale }] }
        : {
            receiving_verification_evidence: [{ ...evidence, [column]: stale }],
          },
    );
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      reason: "EVIDENCE_STALE",
      catalogEligible: false,
    });
  });

  it.each([
    ["account", "observedAt"],
    ["proof", "observedAt"],
    ["proof", "bankObservedAt"],
  ])(
    "does not coalesce a missing %s %s into a newer observation",
    async (source, column) => {
      const { db } = fixture(
        source === "account"
          ? { receiving_account: [{ ...account, [column]: null }] }
          : {
              receiving_verification_evidence: [
                { ...evidence, [column]: null },
              ],
            },
      );
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
        observedAt: null,
      });
    },
  );

  it("keeps the oldest real account observation for later quote reevaluation", async () => {
    const older = new Date(now.getTime() - 10_000);
    const { db } = fixture({
      receiving_account: [{ ...account, observedAt: older }],
    });
    expect(
      (await loadReceivingContext(db, siteId, options))?.evidence?.observedAt,
    ).toEqual(older);
  });

  it.each([
    ["receiving_account", { ...account, observedAt: "not-a-date" }],
    [
      "receiving_verification_evidence",
      { ...evidence, bankObservedAt: "not-a-date" },
    ],
    ["receiving_account", { ...account, accountReference: " " }],
    ["receiving_account", { ...account, recipientReference: null }],
    ["receiving_destination", { ...destination, version: 3.5 }],
    ["receiving_destination", { ...destination, bankReference: null }],
    [
      "receiving_verification_evidence",
      { ...evidence, bankReference: "different-bank" },
    ],
  ] as const)(
    "denies malformed or missing stored binding in %s",
    async (table, row) => {
      const { db } = fixture({ [table]: [row] });
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        catalogEligible: false,
      });
    },
  );

  it("preserves the demo/live environment denial", async () => {
    const { db } = fixture({ site: [{ id: siteId, isDemo: true }] });
    expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
      reason: "ENVIRONMENT_MISMATCH",
      catalogEligible: false,
    });
  });

  it.each([true, false])(
    "simulation can approve only an explicit sandbox demo (isDemo=%s)",
    async (isDemo) => {
      const { db } = fixture({
        site: [{ id: siteId, isDemo }],
        receiving_account: [{ ...account, environment: "sandbox" }],
        receiving_destination: [{ ...destination, environment: "sandbox" }],
        receiving_verification_evidence: [
          { ...evidence, environment: "sandbox", provenance: "SIMULATION" },
        ],
      });
      expect(
        await readReceivingReadiness(db, siteId, {
          ...options,
          mode: "sandbox",
          applicationEnvironment: "test",
        }),
      ).toMatchObject({ mode: "sandbox", catalogEligible: isDemo });
    },
  );

  it("does not invoke remote providers while reading receiving readiness", async () => {
    const remote = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected remote request"));
    try {
      const { db } = fixture();
      expect(await readReceivingReadiness(db, siteId, options)).toMatchObject({
        state: "READY",
      });
      expect(remote).not.toHaveBeenCalled();
    } finally {
      remote.mockRestore();
    }
  });
});
