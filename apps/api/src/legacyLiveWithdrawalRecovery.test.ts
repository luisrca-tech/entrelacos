import { describe, expect, it, vi } from "vitest";
import {
  legacyLiveDispatchRevision,
  legacyLiveDispatchSourceHash,
  legacyWithdrawalRecoveryDigest,
  recoverLegacyLiveWithdrawal,
} from "./legacyLiveWithdrawalRecovery";

const at = new Date("2026-10-25T06:00:00.000Z");
function fixture() {
  const row = {
    operationId: "operation-one",
    withdrawalId: "withdrawal-one",
    siteId: "demo-wedding",
    accountId: "account-one",
    accountReference: "native-account",
    requestId: "request-one",
    requestHash: "a".repeat(64),
    environment: "live",
    operationState: "UNKNOWN",
    withdrawalState: "UNKNOWN",
    attempts: 1,
    reservationState: "HELD",
    reservedCents: 300,
    amountCents: 300,
    providerReference: null,
    providerOperationReference: null,
    receiptReference: null,
    resolutionObservedAt: null,
    leaseOwner: "old-owner",
    leaseToken: "old-token",
    leaseExpiresAt: new Date(+at - 60000).toISOString(),
    requestState: "COMMITTED",
    providerObservations: 0,
    authorizationCandidates: 0,
    debitEntries: 0,
  };
  const events: string[] = [];
  const query = vi.fn(async (text: string) => {
    if (text.startsWith("UPDATE")) {
      events.push("write");
      return {
        rows: [
          {
            id: text.includes("UPDATE withdrawal_intent")
              ? row.withdrawalId
              : row.operationId,
          },
        ],
      };
    }
    if (text.includes('AS "operationId"')) return { rows: [row] };
    return { rows: [{ id: row.siteId }] };
  });
  const native = vi.fn(async () => ({
    accountReference: row.accountReference,
    totalCount: 0,
    hasMore: false,
    balanceCents: 881,
    observedAt: at.toISOString(),
  }));
  const retainAudit = vi.fn(async (audit: unknown) => {
    events.push("audit");
    return legacyWithdrawalRecoveryDigest(audit);
  });
  const options = {
    siteId: row.siteId,
    operationId: row.operationId,
    expectedDigest: legacyWithdrawalRecoveryDigest(row),
    sourceRevision: legacyLiveDispatchRevision,
    sourceHash: legacyLiveDispatchSourceHash,
    now: () => new Date(at),
    native,
    retainAudit,
    transaction: async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
      work({ query }),
  };
  return { row, events, query, native, retainAudit, options };
}
describe("operator recovery of the proven legacy live dispatch block", () => {
  it("retains the old fence before restoring the original held request without a transfer or ledger write", async () => {
    const f = fixture();
    const result = await recoverLegacyLiveWithdrawal(f.options);
    expect(result.state).toBe("REQUESTED");
    expect(f.events).toEqual(["audit", "write", "write"]);
    expect(f.native).toHaveBeenCalledExactlyOnceWith(
      f.row.accountId,
      f.row.accountReference,
    );
    expect(
      f.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE")),
    ).toHaveLength(2);
    expect(
      f.query.mock.calls.every(
        ([sql]) =>
          !/INSERT INTO financial_ledger|DELETE FROM|SET reserved_cents/i.test(
            sql,
          ),
      ),
    ).toBe(true);
    expect(f.retainAudit.mock.calls[0][0]).toMatchObject({
      before: f.row,
      reason: "LEGACY_LIVE_POST_DISABLED",
      sourceRevision: legacyLiveDispatchRevision,
    });
  });
  it.each([
    "digest",
    "source",
    "attempts",
    "provider",
    "observation",
    "candidate",
    "debit",
    "lease",
    "released",
    "foreign",
  ])("refuses %s ambiguity before writes", async (kind) => {
    const f = fixture();
    if (kind === "digest") f.options.expectedDigest = "b".repeat(64);
    if (kind === "source") f.options.sourceHash = "b".repeat(64);
    if (kind === "attempts") f.row.attempts = 2;
    if (kind === "provider")
      Object.assign(f.row, { providerReference: "transfer-one" });
    if (kind === "observation") f.row.providerObservations = 1;
    if (kind === "candidate") f.row.authorizationCandidates = 1;
    if (kind === "debit") f.row.debitEntries = 1;
    if (kind === "lease")
      f.row.leaseExpiresAt = new Date(+at + 1000).toISOString();
    if (kind === "released") f.row.reservationState = "RELEASED";
    if (kind === "foreign") f.row.environment = "sandbox";
    await expect(recoverLegacyLiveWithdrawal(f.options)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it.each(["transfer", "incomplete", "stale", "foreign", "missingBalance"])(
    "keeps the hold when the native %s read is not conclusive",
    async (kind) => {
      const f = fixture();
      const native = await f.native();
      if (kind === "transfer") native.totalCount = 1;
      if (kind === "incomplete") native.hasMore = true;
      if (kind === "stale")
        native.observedAt = new Date(+at - 60001).toISOString();
      if (kind === "foreign") native.accountReference = "other-account";
      if (kind === "missingBalance") native.balanceCents = 0;
      f.native.mockResolvedValue(native);
      await expect(recoverLegacyLiveWithdrawal(f.options)).rejects.toThrow();
      expect(f.events).toEqual([]);
    },
  );
  it("does not change the request when durable audit retention fails", async () => {
    const f = fixture();
    f.retainAudit.mockRejectedValue(new Error("Audit unavailable"));
    await expect(recoverLegacyLiveWithdrawal(f.options)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
});
