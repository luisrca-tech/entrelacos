import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  createWithdrawalReservationRepository,
  type WithdrawalReservationDatabase,
} from "./withdrawalReservationRepository";
import type {
  WithdrawalReservationCurrentAuthorization,
  WithdrawalReservationLockedState,
  WithdrawalReservationSnapshot,
} from "./withdrawalReservations";
import {
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
} from "./withdrawalReservations";

const now = new Date("2026-10-12T20:00:00.000Z");
const scope = {
  siteId: "site-1",
  accountId: "account-1",
  environment: "sandbox",
};
function camel(value: string) {
  return value.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function jsonbRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbRoundTrip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(
        ([left], [right]) =>
          left.length - right.length ||
          (left < right ? -1 : left > right ? 1 : 0),
      )
      .map(([key, child]) => [key, jsonbRoundTrip(child)]),
  );
}

function fixture(live = false) {
  const mode = live ? ("live" as const) : ("sandbox" as const);
  const scope = { siteId: "site-1", accountId: "account-1", environment: mode };
  const snapshot: WithdrawalReservationSnapshot = {
    intent: {
      id: "withdrawal-1",
      siteId: "site-1",
      amountCents: 10_000,
      feeCents: 500,
      netCents: 9_500,
      currency: "BRL",
      destinationVersion: 3,
      state: "REQUESTED",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      mode,
    },
    requestId: "request-1",
    accountId: "account-1",
    operatorUserId: "user:operator.1",
    accountReference: "acct_1",
    recipientReference: "wallet_1",
    bankReference: "bank-1",
    environment: mode,
    operationId: "operation-1",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          "site-1",
          "request-1",
          "user:operator.1",
          mode,
          10_000,
          3,
        ]),
      )
      .digest("hex"),
    authenticationAuditHash: "a".repeat(64),
    feeQuote: {
      feeCents: 500,
      policyVersion: "provider-fee-v1",
      provenance: "provider",
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    balance: { balanceCents: 15_000, observedAt: now.toISOString() },
  };
  const actor = {
    userId: snapshot.operatorUserId,
    siteId: "site-1",
    sessionId: "session:new.1",
  };
  const authorization: WithdrawalReservationCurrentAuthorization = {
    actor,
    recentAuth: {
      ...actor,
      proofKind: "PASSWORD_REAUTHENTICATION",
      provenance: "backend",
      verification: "verified",
      authenticatedAt: new Date(now.getTime() - 30_000),
      expiresAt: new Date(now.getTime() + 270_000),
    },
  };
  const account = {
    id: "account-1",
    siteId: "site-1",
    environment: mode,
    provider: "ASAAS",
    operatorUserId: actor.userId,
    operatorReference: "operator-remote-1",
    accountReference: "acct_1",
    recipientReference: "wallet_1",
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    isCurrent: true,
    observedAt: new Date(now),
  };
  const destination = {
    ...scope,
    id: "destination-3",
    version: 3,
    bankReference: "bank-1",
    bankState: "VERIFIED",
    isCurrent: true,
  };
  const evidence = {
    ...scope,
    id: "evidence-1",
    createdAt: new Date(now),
    destinationVersion: 3,
    operatorReference: account.operatorReference,
    accountReference: "acct_1",
    recipientReference: "wallet_1",
    bankReference: "bank-1",
    verificationStatus: "VERIFIED",
    verificationReference: "verified-1",
    provenance: "PROVIDER",
    providerAccountState: "APPROVED",
    bankState: "VERIFIED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    observedAt: new Date(now),
    bankObservedAt: new Date(now),
  };
  const storedUser = {
    userId: actor.userId,
    role: "SITE_ADMIN",
    state: "ACTIVE",
    operatorDisplayName: "Stored Operator",
    operatorProfileUpdatedAt: new Date(now),
  };
  const storedSession = {
    userId: actor.userId,
    sessionId: actor.sessionId,
    sessionExpiresAt: "2026-10-13 20:00:00.000000+00",
    lastActiveAt: "2026-10-12 19:59:00+00",
    sessionCreatedAt: "2026-10-12 19:00:00+00",
  };
  const membership = {
    id: "membership-1",
    siteId: "site-1",
    userId: actor.userId,
    role: "SITE_ADMIN",
    revokedAt: null,
  };
  const access = {
    user_id: actor.userId,
    account_role: "SITE_ADMIN",
    account_state: "ACTIVE",
    site_id: "site-1",
    membership_id: membership.id,
    membership_user_id: actor.userId,
    membership_role: "SITE_ADMIN",
    revoked_at: null,
  };
  const site = { siteId: "site-1", id: "site-1", isDemo: true };
  const presentation = {
    ...scope,
    accountReference: "acct_1",
    bankReference: "bank-1",
    destinationVersion: 3,
    amountCents: 10000,
    currency: "BRL" as const,
    environment: mode,
    source: "stored" as const,
    verification: "verified" as const,
    provenance: "provider" as const,
    operatorUserId: actor.userId,
    recipientReference: "wallet_1",
    destinationId: destination.id,
    evidenceId: evidence.id,
    verificationReference: evidence.verificationReference,
    evidenceObservedAt: new Date(now),
    bankObservedAt: new Date(now),
    operatorProfileUpdatedAt: new Date(now),
    maskedDestination: "Bank **** 1234",
    operatorDisplayName: storedUser.operatorDisplayName,
  };
  const consentSnapshot = readWithdrawalConsentSnapshot({
    preview: {
      siteId: actor.siteId,
      requestId: snapshot.requestId,
      mode,
      currency: "BRL",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      destinationVersion: 3,
      maskedDestination: presentation.maskedDestination,
      operatorDisplayName: presentation.operatorDisplayName,
      policyVersion: snapshot.feeQuote.policyVersion,
      issuedAt: now.toISOString(),
      expiresAt: snapshot.feeQuote.expiresAt,
    },
    scope: {
      ...scope,
      accountReference: "acct_1",
      bankReference: "bank-1",
      destinationVersion: 3,
      amountCents: 10000,
      currency: "BRL",
    },
    operatorUserId: actor.userId,
    recipientReference: "wallet_1",
    presentation,
    feeQuote: snapshot.feeQuote,
  });
  const previewHash = hashWithdrawalConsentSnapshot(consentSnapshot);
  const confirmation = {
    requestId: snapshot.requestId,
    previewHash,
    requestRevision: "1" as const,
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    withdrawal_request: [
      {
        id: "request-row-1",
        ...scope,
        operatorUserId: actor.userId,
        destinationVersion: 3,
        requestId: snapshot.requestId,
        previewSnapshot: consentSnapshot,
        previewHash,
        expiresAt: snapshot.feeQuote.expiresAt,
        state: "OPEN",
        requestRevision: 1n,
        withdrawalIntentId: null,
        sealedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
    withdrawal_intent: [],
    financial_operation: [],
    financial_event_inbox: [],
    gift_payment_record: [],
    financial_ledger_entry: [],
    receiving_account: [account],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clock = { sql: "2026-10-12 20:00:00.000000+00", app: new Date(now) };
  const budget = {
    heldCents: "5000",
    unresolvedFinancialEventCount: "0",
    balanceEffectsAfterObservationCount: "0",
  };
  const faults = {
    failInsert: "",
    commitAfterApplied: false,
    callbackClock: "",
    jsonbRoundTrip: false,
    onQuery: null as ((text: string) => void) | null,
  };
  let before: typeof tables | null = null;
  const query = vi.fn(
    async (
      statement: string | { text: string; rowMode?: string },
      params: unknown[] = [],
    ) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      faults.onQuery?.(text);
      if (/^begin/i.test(text)) {
        before = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        before = null;
        if (faults.commitAfterApplied)
          throw new Error("password=test-secret commit lost");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (before)
          for (const name of Object.keys(tables)) tables[name] = before[name];
        before = null;
        return { rows: [] };
      }
      if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
      if (/SELECT clock_timestamp\(\)/i.test(text))
        return { rows: [{ currentTime: clock.sql }] };
      if (/UPDATE "withdrawal_request" r/i.test(text)) {
        if (/state='SEALED_NOT_CREATED'/.test(text)) {
          const row = tables.withdrawal_request.find(
            (r) =>
              r.id === params[2] &&
              r.siteId === params[3] &&
              r.requestId === params[4] &&
              r.operatorUserId === params[5] &&
              r.environment === params[6] &&
              r.previewHash === params[7] &&
              r.state === "OPEN" &&
              String(r.requestRevision) === "1" &&
              r.withdrawalIntentId === null &&
              r.sealedAt === null,
          );
          if (!row) return { rows: [] };
          Object.assign(row, {
            state: "SEALED_NOT_CREATED",
            requestRevision: 2n,
            sealedAt: params[0],
            updatedAt: params[1],
          });
          return { rows: [{ id: row.id }] };
        }
        const row = tables.withdrawal_request.find(
          (r) =>
            r.id === params[1] &&
            r.siteId === params[2] &&
            r.accountId === params[3] &&
            r.environment === params[4] &&
            r.operatorUserId === params[5] &&
            r.destinationVersion === params[6] &&
            r.requestId === params[7] &&
            r.previewHash === params[8] &&
            r.state === "OPEN" &&
            String(r.requestRevision) === "1" &&
            r.withdrawalIntentId === null &&
            r.sealedAt === null &&
            databaseTimestampEpochMicroseconds(r.expiresAt) >
              databaseTimestampEpochMicroseconds(clock.sql),
        );
        if (!row) return { rows: [] };
        Object.assign(row, {
          state: "COMMITTED",
          requestRevision: 2n,
          withdrawalIntentId: params[0],
          updatedAt: clock.sql,
        });
        return { rows: [{ id: row.id }] };
      }
      if (/FROM "withdrawal_request" r/i.test(text)) {
        if (/SUM\(r.request_revision\)/.test(text))
          return {
            rows: [
              {
                scopeRevision: tables.withdrawal_request
                  .filter(
                    (r) =>
                      r.siteId === params[0] && r.environment === params[1],
                  )
                  .reduce(
                    (sum, r) => sum + BigInt(r.requestRevision as string),
                    0n,
                  )
                  .toString(),
              },
            ],
          };
        const selected = tables.withdrawal_request.filter(
          (r) =>
            r.siteId === params[0] &&
            (/r\.request_id=/.test(text)
              ? r.requestId === params[1]
              : r.environment === params[1] && r.operatorUserId === params[2]),
        );
        const projection = text
          .split(/FROM/i)[0]
          .replace(/^SELECT\s+/i, "")
          .split(",");
        return {
          rows: selected.map((row) =>
            Object.fromEntries(
              projection.map((part) => {
                const field = part
                  .trim()
                  .match(/^r\.([a-z_]+)(::text)?(?: AS "([^"]+)")?$/);
                if (!field)
                  throw new Error("Unsupported actual request projection");
                const key = camel(field[1]);
                return [
                  field[3] ?? key,
                  field[2] ? String(row[key]) : row[key],
                ];
              }),
            ),
          ),
        };
      }
      if (/AS "scopeUnresolvedCount"/.test(text)) {
        const scoped = (row: Record<string, unknown>) =>
          row.siteId === params[0] &&
          row.environment === params[1] &&
          tables.receiving_account.some(
            (a) =>
              a.id === row.accountId &&
              a.siteId === row.siteId &&
              a.environment === row.environment &&
              a.operatorUserId === params[2],
          );
        const actual =
          tables.financial_event_inbox.filter(
            (row) =>
              scoped(row) &&
              row.authenticatedAt !== null &&
              row.state !== "PROCESSED" &&
              /^(PAYMENT|CHECKOUT|TRANSFER|REFUND)_/.test(
                String(row.eventType),
              ),
          ).length +
          tables.financial_operation.filter(
            (row) => scoped(row) && row.state === "UNKNOWN",
          ).length +
          tables.gift_payment_record.filter(
            (row) =>
              scoped(row) &&
              (row.providerStatus === null ||
                row.verificationStatus !== "VERIFIED" ||
                ![
                  "PENDING",
                  "AUTHORIZED",
                  "CONFIRMED",
                  "RECEIVED",
                  "OVERDUE",
                ].includes(String(row.providerStatus))),
          ).length;
        const unknownIntents = /w\.state='UNKNOWN'/.test(text)
          ? tables.withdrawal_intent.filter(
              (row) =>
                scoped(row) &&
                row.operatorUserId === params[2] &&
                row.state === "UNKNOWN",
            ).length
          : 0;
        return {
          rows: [
            {
              scopeUnresolvedCount: (
                BigInt(actual + unknownIntents) +
                BigInt(budget.unresolvedFinancialEventCount)
              ).toString(),
            },
          ],
        };
      }
      if (/AS "heldCents"/i.test(text)) {
        const sum =
          typeof budget.heldCents === "string" &&
          /^(0|[1-9]\d*)$/.test(budget.heldCents)
            ? (
                BigInt(budget.heldCents) +
                tables.withdrawal_intent
                  .filter(
                    (row) =>
                      row.siteId === scope.siteId &&
                      row.accountId === scope.accountId &&
                      row.environment === scope.environment &&
                      row.reservationState === "HELD" &&
                      [
                        "REQUESTED",
                        "AWAITING_AUTHORIZATION",
                        "PROCESSING",
                        "UNKNOWN",
                      ].includes(String(row.state)),
                  )
                  .reduce(
                    (total, row) => total + BigInt(row.reservedCents as number),
                    0n,
                  )
              ).toString()
            : budget.heldCents;
        const observed = databaseTimestampEpochMicroseconds(params.at(-1));
        const effects =
          tables.withdrawal_intent.filter(
            (row) =>
              row.siteId === scope.siteId &&
              row.accountId === scope.accountId &&
              row.environment === scope.environment &&
              row.state === "COMPLETED" &&
              databaseTimestampEpochMicroseconds(row.updatedAt) >= observed,
          ).length +
          tables.financial_ledger_entry.filter(
            (row) =>
              row.siteId === scope.siteId &&
              row.accountId === scope.accountId &&
              row.environment === scope.environment &&
              row.direction === "DEBIT" &&
              databaseTimestampEpochMicroseconds(row.createdAt) >= observed,
          ).length;
        const scoped = (row: Record<string, unknown>) =>
          row.siteId === scope.siteId &&
          row.accountId === scope.accountId &&
          row.environment === scope.environment;
        const pending =
          tables.financial_event_inbox.filter(
            (row) =>
              scoped(row) &&
              row.authenticatedAt !== null &&
              row.state !== "PROCESSED" &&
              /^(PAYMENT|CHECKOUT|TRANSFER|REFUND)_/.test(
                String(row.eventType),
              ),
          ).length +
          tables.financial_operation.filter(
            (row) => scoped(row) && row.state === "UNKNOWN",
          ).length +
          tables.gift_payment_record.filter(
            (row) =>
              scoped(row) &&
              (row.providerStatus === null ||
                row.verificationStatus !== "VERIFIED" ||
                ![
                  "PENDING",
                  "AUTHORIZED",
                  "CONFIRMED",
                  "RECEIVED",
                  "OVERDUE",
                ].includes(String(row.providerStatus))),
          ).length;
        const unresolved =
          typeof budget.unresolvedFinancialEventCount === "string" &&
          /^(0|[1-9]\d*)$/.test(budget.unresolvedFinancialEventCount)
            ? (
                BigInt(budget.unresolvedFinancialEventCount) + BigInt(pending)
              ).toString()
            : budget.unresolvedFinancialEventCount;
        const watermark =
          typeof budget.balanceEffectsAfterObservationCount === "string" &&
          /^(0|[1-9]\d*)$/.test(budget.balanceEffectsAfterObservationCount)
            ? (
                BigInt(budget.balanceEffectsAfterObservationCount) +
                BigInt(effects)
              ).toString()
            : budget.balanceEffectsAfterObservationCount;
        return {
          rows: [
            {
              ...budget,
              heldCents: sum,
              unresolvedFinancialEventCount: unresolved,
              balanceEffectsAfterObservationCount: watermark,
            },
          ],
        };
      }
      if (/FROM "withdrawal_intent" w/i.test(text)) {
        const withdrawals = tables.withdrawal_intent.filter(
          (row) =>
            row.siteId === params[0] &&
            (/w\.request_id=/.test(text)
              ? row.requestId === params[1]
              : row.environment === params[1] &&
                row.operatorUserId === params[2]),
        );
        return {
          rows: withdrawals.map((withdrawal) => ({
            ...withdrawal,
            accountProvider: account.provider,
            accountOperatorUserId: account.operatorUserId,
          })),
        };
      }
      if (/FROM "financial_operation" op/i.test(text))
        return {
          rows: tables.financial_operation.filter(
            (row) =>
              row.siteId === params[0] &&
              (/op\.withdrawal_intent_id=/.test(text)
                ? row.withdrawalIntentId === params[1]
                : /op\.request_id=/.test(text)
                  ? row.requestId === params[1] && row.kind === "WITHDRAWAL"
                  : row.environment === params[1] &&
                    account.operatorUserId === params[2] &&
                    row.kind === "WITHDRAWAL"),
          ),
        };
      if (/INNER JOIN site s/i.test(text)) return { rows: [access] };
      if (typeof statement !== "string" && statement.rowMode === "array") {
        const source = /from "site"/i.test(text)
          ? [site]
          : /from "receiving_account"/i.test(text)
            ? [account]
            : /from "receiving_destination"/i.test(text)
              ? [destination]
              : /from "receiving_verification_evidence"/i.test(text)
                ? [evidence]
                : [];
        const columns = [
          ...text
            .slice(0, text.toLowerCase().indexOf(" from "))
            .matchAll(/"([a-z_]+)"/g),
        ].map((match) => camel(match[1]));
        return {
          rows: source.map((row) =>
            columns.map((column) => row[column as keyof typeof row]),
          ),
        };
      }
      if (/FROM "site" st/i.test(text)) return { rows: [site] };
      if (/FROM "user" u/i.test(text)) return { rows: [storedUser] };
      if (/FROM "session" se/i.test(text)) return { rows: [storedSession] };
      if (/FROM "site_membership" m/i.test(text)) return { rows: [membership] };
      if (/FROM "receiving_account" a/i.test(text)) return { rows: [account] };
      if (/FROM "receiving_destination" d/i.test(text))
        return { rows: [destination] };
      if (/FROM "receiving_verification_evidence" ev/i.test(text))
        return { rows: [evidence] };
      const insert = text.match(
        /^insert into "([a-z_]+)" \((.*?)\) values \((.*?)\)/i,
      );
      if (insert) {
        if (faults.failInsert === insert[1])
          throw new Error("password=test-secret insert failed");
        const columns = insert[2]
          .split(",")
          .map((part) => camel(part.trim().replaceAll('"', "")));
        const values = insert[3].split(",").map((part) => {
          const index = part.trim().match(/^\$(\d+)(?:::\w+)?$/);
          return index
            ? params[Number(index[1]) - 1]
            : /^'(.+)'$/.test(part.trim())
              ? part.trim().slice(1, -1)
              : /^\d+$/.test(part.trim())
                ? BigInt(part.trim())
                : null;
        });
        const row = Object.fromEntries(
          columns.map((column, index) => [column, values[index]]),
        );
        if (typeof row.requestSnapshot === "string")
          row.requestSnapshot = JSON.parse(row.requestSnapshot);
        if (typeof row.previewSnapshot === "string")
          row.previewSnapshot = JSON.parse(row.previewSnapshot);
        if (faults.jsonbRoundTrip && row.previewSnapshot)
          row.previewSnapshot = jsonbRoundTrip(row.previewSnapshot);
        tables[insert[1]].push(row);
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`Unexpected test query: ${text}`);
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  const options = {
    mode,
    applicationEnvironment: live ? ("production" as const) : ("test" as const),
    maxAuthAgeMs: 300_000,
    freshnessMs: 60_000,
    now: () => new Date(clock.app),
    loadVerifiedPresentationInTransaction: vi.fn(
      async (_tx: unknown, selected: unknown) => {
        if (
          selected &&
          typeof selected === "object" &&
          "amountCents" in selected
        )
          return presentation;
        const { amountCents: _, currency: __, ...stored } = presentation;
        return stored as typeof presentation;
      },
    ),
  };
  const authorize = vi.fn(async (_state: WithdrawalReservationLockedState) => {
    if (faults.callbackClock) clock.sql = faults.callbackClock;
  });
  return {
    snapshot,
    authorization,
    account,
    destination,
    evidence,
    storedUser,
    storedSession,
    membership,
    access,
    site,
    tables,
    queries,
    clock,
    budget,
    faults,
    db,
    options,
    authorize,
    query,
    confirmation,
    consentSnapshot,
    presentation,
  };
}

describe("durable withdrawal reservation repository", () => {
  it("denies every naked first SQL hold without accepted OPEN consent", async () => {
    const values = fixture();
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
      ),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    expect(values.tables.withdrawal_intent).toHaveLength(0);
    expect(values.tables.financial_operation).toHaveLength(0);
  });
  it("locks actual authority and stores one REQUESTED HELD intent plus one immutable WITHDRAWAL operation", async () => {
    const values = fixture();
    const result = await createWithdrawalReservationRepository(
      values.db,
      values.options,
    ).reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    expect(result).toEqual({
      snapshot: values.snapshot,
      intent: values.snapshot.intent,
    });
    expect(values.authorize).toHaveBeenCalledOnce();
    expect(values.authorize.mock.calls[0]?.[0]).toMatchObject({
      currentSession: values.authorization.actor,
      heldCents: 5_000n,
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
      context: {
        verification: "verified",
        accountId: "account-1",
        readiness: { state: "READY" },
      },
    });
    expect(values.tables.withdrawal_intent).toHaveLength(1);
    expect(values.tables.withdrawal_intent[0]).toMatchObject({
      state: "REQUESTED",
      reservationState: "HELD",
      reservedCents: 10_000,
      authorizationReference: "a".repeat(64),
      providerReference: null,
      resolutionObservedAt: null,
    });
    expect(values.tables.financial_operation[0]).toMatchObject({
      kind: "WITHDRAWAL",
      state: "REQUESTED",
      attempts: 0,
      requestSnapshot: values.snapshot,
      providerOperationReference: null,
      leaseToken: null,
    });
  });

  it("denies a receiving observation one microsecond in the future before its Date projection can truncate it", async () => {
    const values = fixture();
    Object.assign(values.account, {
      observedAt: "2026-10-12T20:00:00.000001Z",
    });
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "DESTINATION_UNVERIFIED" });
    expect(values.tables.withdrawal_intent).toHaveLength(0);
  });

  it("rechecks stored readiness freshness after a delayed authorization callback", async () => {
    const values = fixture();
    const prior = new Date(now.getTime() - 59_000);
    values.account.observedAt = prior;
    values.evidence.observedAt = prior;
    values.evidence.bankObservedAt = prior;
    values.presentation.evidenceObservedAt = prior;
    values.presentation.bankObservedAt = prior;
    const consent = readWithdrawalConsentSnapshot({
      ...values.consentSnapshot,
      presentation: {
        ...values.consentSnapshot.presentation,
        evidenceObservedAt: prior.toISOString(),
        bankObservedAt: prior.toISOString(),
      },
    });
    const previewHash = hashWithdrawalConsentSnapshot(consent);
    Object.assign(values.tables.withdrawal_request[0], {
      previewSnapshot: consent,
      previewHash,
    });
    values.confirmation.previewHash = previewHash;
    values.faults.callbackClock = "2026-10-12T20:00:02.000000Z";
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "DESTINATION_UNVERIFIED" });
    expect(values.tables.withdrawal_intent).toHaveLength(0);
  });

  it("rejects corrupted typed dependency error metadata without echoing its contents", async () => {
    const values = fixture();
    const { WithdrawalReservationServiceError } = await import(
      "./withdrawalReservations"
    );
    const error = new WithdrawalReservationServiceError(
      503,
      "WITHDRAWAL_UNAVAILABLE",
    );
    Object.assign(error, {
      code: "password=test-secret",
      cause: new Error("provider-payer"),
    });
    values.authorize.mockImplementation(async () => {
      throw error;
    });
    await denied(values, "WITHDRAWAL_UNAVAILABLE", 503);
  });

  it("denies when the actual site resolver observes revocation after the membership projection", async () => {
    const values = fixture();
    Object.assign(values.access, { revoked_at: new Date(now) });
    await denied(values, "MEMBERSHIP_DENIED", 403);
  });

  it("uses explicit lock ordering, scoped parameters and safe projections without nested transactions", async () => {
    const values = fixture();
    await createWithdrawalReservationRepository(
      values.db,
      values.options,
    ).reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    const queries = values.queries.map((query) => query.sql);
    const locks = [
      /pg_advisory_xact_lock/,
      /FOR UPDATE OF st/,
      /FOR SHARE OF u/,
      /FOR SHARE OF se/,
      /FOR SHARE OF m/,
      /FOR UPDATE OF a/,
      /FOR SHARE OF d/,
      /FOR SHARE OF ev/,
      /FOR UPDATE OF w/,
      /FOR UPDATE OF op/,
    ];
    const positions = locks.map((pattern) =>
      queries.findIndex((query) => pattern.test(query)),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(queries.filter((query) => /^begin/i.test(query))).toHaveLength(1);
    expect(
      queries.some((query) =>
        /savepoint|access_token|credential_|webhook_token_hash|password|masked_descriptor|SELECT\s+\*/i.test(
          query,
        ),
      ),
    ).toBe(false);
    const accountLock = values.queries.find((query) =>
      /FOR UPDATE OF a/.test(query.sql),
    );
    expect(accountLock?.params).toEqual(["account-1", "site-1", "sandbox"]);
    expect(accountLock?.sql).not.toContain("acct_1");
    const budget = values.queries.find((query) =>
      /AS "heldCents"/.test(query.sql),
    );
    expect(budget?.sql).toContain(
      "'REQUESTED','AWAITING_AUTHORIZATION','PROCESSING','UNKNOWN'",
    );
    expect(budget?.sql).toContain("ev.authenticated_at IS NOT NULL");
    expect(budget?.sql).toContain("ev.state<>'PROCESSED'");
    expect(budget?.sql).toContain("op.state='UNKNOWN'");
    expect(budget?.sql).toContain("w.updated_at>=");
    expect(budget?.sql).toContain("le.created_at>=");
    expect(
      budget?.params.filter(
        (value) => value === values.snapshot.balance.observedAt,
      ),
    ).toHaveLength(2);
  });

  it("does not execute SQL in disabled mode", async () => {
    const values = fixture();
    const repository = createWithdrawalReservationRepository(values.db, {
      mode: "disabled",
    });
    await expect(
      repository.findByRequest("site-1", "request-1"),
    ).rejects.toMatchObject({ status: 409, code: "PROVIDER_MODE_UNAVAILABLE" });
    await expect(
      repository.reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "PROVIDER_MODE_UNAVAILABLE" });
    expect(values.query).not.toHaveBeenCalled();
  });

  it.each([0, -1, 300_001, 1.5])(
    "rejects invalid freshness/auth options %s before SQL",
    (amount) => {
      const values = fixture();
      for (const key of ["freshnessMs", "maxAuthAgeMs"] as const)
        expect(() =>
          createWithdrawalReservationRepository(values.db, {
            ...values.options,
            [key]: amount,
          }),
        ).toThrowError(expect.objectContaining({ status: 503 }));
      expect(values.query).not.toHaveBeenCalled();
    },
  );

  it("denies live outside production or demo live bindings", async () => {
    const values = fixture();
    expect(() =>
      createWithdrawalReservationRepository(values.db, {
        ...values.options,
        mode: "live",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PROVIDER_MODE_UNAVAILABLE" }),
    );
    const live = structuredClone(values.snapshot);
    const candidate = {
      ...live,
      environment: "live" as const,
      intent: { ...live.intent, mode: "live" as const },
    };
    candidate.requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          "site-1",
          "request-1",
          candidate.operatorUserId,
          "live",
          10_000,
          3,
        ]),
      )
      .digest("hex");
    await expect(
      createWithdrawalReservationRepository(values.db, {
        ...values.options,
        mode: "live",
        applicationEnvironment: "production",
      }).reserveWithdrawal(candidate, values.authorize, values.authorization),
    ).rejects.toMatchObject({ status: 409, code: "PROVIDER_MODE_UNAVAILABLE" });
    expect(values.authorize).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "disabled user",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedUser.state = "DISABLED";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "OWNER",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedUser.role = "OWNER";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "revoked member",
      patch: (v: ReturnType<typeof fixture>) => {
        Object.assign(v.membership, { revokedAt: now });
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "assessor",
      patch: (v: ReturnType<typeof fixture>) => {
        v.membership.role = "SITE_ASSISTANT";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "crosssite member",
      patch: (v: ReturnType<typeof fixture>) => {
        v.membership.siteId = "other-site";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "changed session",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedSession.sessionId = "old-session";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "expired session",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedSession.sessionExpiresAt = "2026-10-12T20:00:00.000000Z";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "idle 24h",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedSession.lastActiveAt = "2026-10-11T20:00:00Z";
        v.storedSession.sessionCreatedAt = "2026-10-11T19:00:00Z";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "absolute 7d",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedSession.sessionCreatedAt = "2026-10-05T20:00:00Z";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "future activity microsecond",
      patch: (v: ReturnType<typeof fixture>) => {
        v.storedSession.lastActiveAt = "2026-10-12T20:00:00.000001Z";
      },
      code: "MEMBERSHIP_DENIED",
      status: 403,
    },
    {
      name: "foreign operator",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.operatorUserId = "other-operator";
      },
      code: "RECIPIENT_REQUIRED",
      status: 403,
    },
    {
      name: "foreign account",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.siteId = "other-site";
      },
      code: "RECIPIENT_REQUIRED",
      status: 403,
    },
    {
      name: "wrong provider",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.provider = "OTHER";
      },
      code: "RECIPIENT_REQUIRED",
      status: 403,
    },
    {
      name: "old account",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.isCurrent = false;
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      name: "changed bank",
      patch: (v: ReturnType<typeof fixture>) => {
        v.destination.bankReference = "bank-2";
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      name: "old destination",
      patch: (v: ReturnType<typeof fixture>) => {
        v.destination.isCurrent = false;
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      name: "wrong destination version",
      patch: (v: ReturnType<typeof fixture>) => {
        v.destination.version = 4;
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      name: "pending bank",
      patch: (v: ReturnType<typeof fixture>) => {
        v.destination.bankState = "PENDING";
      },
      code: "DESTINATION_UNVERIFIED",
      status: 409,
    },
    {
      name: "account suspension",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.providerAccountState = "SUSPENDED";
      },
      code: "RECEIVING_NOT_READY",
      status: 409,
    },
    {
      name: "withdrawal capability false",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.withdrawalCapability = false;
      },
      code: "RECEIVING_NOT_READY",
      status: 409,
    },
    {
      name: "commercial disabled",
      patch: (v: ReturnType<typeof fixture>) => {
        v.account.commercialEnabled = false;
      },
      code: "RECEIVING_NOT_READY",
      status: 409,
    },
    {
      name: "latest evidence unverified",
      patch: (v: ReturnType<typeof fixture>) => {
        v.evidence.verificationStatus = "UNVERIFIED";
      },
      code: "RECEIVING_NOT_READY",
      status: 409,
    },
  ])(
    "denies $name using actual locked records",
    async ({ patch, code, status }) => {
      const values = fixture();
      patch(values);
      await denied(values, code, status);
      expect(values.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([
    "heldCents",
    "unresolvedFinancialEventCount",
    "balanceEffectsAfterObservationCount",
  ] as const)(
    "denies missing/corrupt aggregate %s rather than defaulting to zero",
    async (field) => {
      for (const value of [null, undefined, "-1", "1.1", "", 0]) {
        const values = fixture();
        Object.assign(values.budget, { [field]: value });
        await denied(values, "WITHDRAWAL_UNAVAILABLE", 503);
      }
    },
  );

  it.each([
    "unresolvedFinancialEventCount",
    "balanceEffectsAfterObservationCount",
  ] as const)("denies actual nonzero %s under account lock", async (field) => {
    const values = fixture();
    values.budget[field] = "1";
    await denied(values, "FINANCIAL_EVENTS_UNRESOLVED", 409);
  });

  it("denies an UNKNOWN hold or huge aggregate which exhausts the real balance", async () => {
    for (const held of ["5001", "9007199254740993"]) {
      const values = fixture();
      values.budget.heldCents = held;
      await denied(values, "INSUFFICIENT_FUNDS", 409);
    }
  });

  it("rereads committed HELD sums for two concurrent distinct requests in the simulated serial transaction port", async () => {
    const values = fixture();
    let tail = Promise.resolve();
    const serialDatabase: WithdrawalReservationDatabase = {
      execute: values.db.execute.bind(values.db),
      transaction<T>(
        callback: (tx: ReceivingTransaction) => Promise<T>,
        config?: Parameters<typeof values.db.transaction>[1],
      ): Promise<T> {
        const work = tail.then(() => {
          if (
            values.tables.withdrawal_request[0].state === "COMMITTED" &&
            !values.tables.withdrawal_request.some(
              (r) => r.requestId === "request-2",
            )
          ) {
            const consent = readWithdrawalConsentSnapshot({
              ...values.consentSnapshot,
              preview: {
                ...values.consentSnapshot.preview,
                requestId: "request-2",
              },
            });
            values.tables.withdrawal_request.push({
              ...values.tables.withdrawal_request[0],
              id: "request-row-2",
              requestId: "request-2",
              previewSnapshot: consent,
              previewHash: hashWithdrawalConsentSnapshot(consent),
              state: "OPEN",
              requestRevision: 1n,
              withdrawalIntentId: null,
              updatedAt: now.toISOString(),
            });
          }
          return values.db.transaction(callback, config);
        });
        tail = work.then(
          () => undefined,
          () => undefined,
        );
        return work;
      },
    };
    const repository = createWithdrawalReservationRepository(
      serialDatabase,
      values.options,
    );
    const second = {
      ...values.snapshot,
      requestId: "request-2",
      operationId: "operation-2",
      intent: { ...values.snapshot.intent, id: "withdrawal-2" },
    };
    second.requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          "site-1",
          "request-2",
          second.operatorUserId,
          "sandbox",
          10_000,
          3,
        ]),
      )
      .digest("hex");
    const secondConsent = readWithdrawalConsentSnapshot({
      ...values.consentSnapshot,
      preview: {
        ...values.consentSnapshot.preview,
        requestId: second.requestId,
      },
    });
    const results = await Promise.allSettled(
      [values.snapshot, second].map((candidate) =>
        repository.reserveWithdrawal(
          candidate,
          values.authorize,
          values.authorization,
          candidate.requestId === second.requestId
            ? {
                requestId: second.requestId,
                previewHash: hashWithdrawalConsentSnapshot(secondConsent),
                requestRevision: "1",
              }
            : values.confirmation,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "INSUFFICIENT_FUNDS" }),
      }),
    ]);
    expect(values.tables.withdrawal_intent).toHaveLength(1);
    expect(values.tables.financial_operation).toHaveLength(1);
  });

  it("rejects a completed withdrawal since balance observation even after its HELD reservation was consumed", async () => {
    const values = fixture();
    values.budget.heldCents = "0";
    values.tables.withdrawal_intent.push({
      ...scope,
      id: "completed-other",
      requestId: "other-request",
      state: "COMPLETED",
      reservationState: "CONSUMED",
      reservedCents: 0,
      amountCents: 10_000,
      updatedAt: now.toISOString(),
    });
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "FINANCIAL_EVENTS_UNRESOLVED",
    });
    expect(values.tables.withdrawal_intent).toHaveLength(1);
    expect(values.tables.financial_operation).toHaveLength(0);
    expect(values.authorize).not.toHaveBeenCalled();
  });

  it.each([
    "2026-02-30 20:00:00+00",
    "2026-10-12 20:00:00",
    "2026-10-12T20:00:00+16:00",
    "invalid",
    null,
  ])("rejects malformed stored SQL clock %#", async (clock) => {
    const values = fixture();
    Object.assign(values.clock, { sql: clock });
    await denied(values, "WITHDRAWAL_UNAVAILABLE", 503);
  });

  it("does not normalize a caller clock or current proof from a SQL string", async () => {
    for (const field of ["clock", "proof"]) {
      const values = fixture();
      if (field === "clock")
        Object.assign(values.options, { now: () => "2026-10-12 20:00:00+00" });
      else
        Object.assign(values.authorization.recentAuth, {
          authenticatedAt: "2026-10-12 19:59:30+00",
        });
      await denied(values, "WITHDRAWAL_UNAVAILABLE", 503);
      expect(values.query).not.toHaveBeenCalled();
    }
  });

  it("checks fee expiry with exact SQL microseconds after awaiting authorization", async () => {
    const values = fixture();
    values.faults.callbackClock = "2026-10-12T20:01:00.000001Z";
    await denied(values, "FEE_QUOTE_UNAVAILABLE", 409);
    expect(values.tables.withdrawal_intent).toHaveLength(0);
  });

  it.each([
    [60_000, "before", 0],
    [60_000, "before", 1],
    [60_000, "after", 0],
    [60_000, "after", 1],
    [60_000, "during commit after", 0],
    [60_000, "during commit after", 1],
    [120_000, "before", 0],
    [120_000, "before", 1],
    [120_000, "after", 0],
    [120_000, "after", 1],
    [120_000, "during commit after", 0],
    [120_000, "during commit after", 1],
  ] as const)(
    "does not renew an original %ims preview %s authorization at SQL expiry plus %i microseconds",
    async (lifetime, phase, microseconds) => {
      const v = fixture();
      v.options.freshnessMs = 300_000;
      const expiresAt = new Date(now.getTime() + lifetime).toISOString();
      const original = readWithdrawalConsentSnapshot({
        ...v.consentSnapshot,
        preview: { ...v.consentSnapshot.preview, expiresAt },
        feeQuote: { ...v.consentSnapshot.feeQuote, expiresAt },
      });
      const previewHash = hashWithdrawalConsentSnapshot(original);
      Object.assign(v.tables.withdrawal_request[0], {
        previewSnapshot: original,
        previewHash,
        expiresAt,
      });
      v.confirmation.previewHash = previewHash;
      v.snapshot = {
        ...v.snapshot,
        feeQuote: {
          ...v.snapshot.feeQuote,
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
        },
      };
      const sqlTime = expiresAt.replace(".000Z", `.00000${microseconds}Z`);
      if (phase === "before") v.clock.sql = sqlTime;
      else if (phase === "after") v.faults.callbackClock = sqlTime;
      else
        v.faults.onQuery = (text) => {
          if (/UPDATE "withdrawal_request" r/.test(text)) v.clock.sql = sqlTime;
        };
      await denied(v, "PREVIEW_EXPIRED", 409);
      expect(v.tables.withdrawal_request[0]).toMatchObject({
        state: "OPEN",
        previewHash,
        expiresAt,
        previewSnapshot: original,
      });
      expect(v.tables.financial_operation).toHaveLength(0);
      expect(v.tables.financial_ledger_entry).toHaveLength(0);
    },
  );

  it("checks current proof expiry after awaiting authorization independently of the old audit hash", async () => {
    const values = fixture();
    values.faults.callbackClock = "2026-10-12T20:04:30.000001Z";
    await denied(values, "RECENT_AUTH_REQUIRED", 403);
  });

  it("checks session activity on the final SQL clock after await", async () => {
    const values = fixture();
    values.storedSession.lastActiveAt = "2026-10-11T20:00:01.000000Z";
    values.storedSession.sessionCreatedAt = "2026-10-11T19:00:00+00";
    values.faults.callbackClock = "2026-10-12T20:00:01.000001Z";
    await denied(values, "MEMBERSHIP_DENIED", 403);
  });

  it("requires the authorization callback to succeed and return undefined", async () => {
    for (const kind of ["throw", "return"]) {
      const values = fixture();
      const callback =
        kind === "throw"
          ? async () => {
              throw new Error("password=test-secret");
            }
          : async () => true;
      await expect(
        createWithdrawalReservationRepository(
          values.db,
          values.options,
        ).reserveWithdrawal(
          values.snapshot,
          callback as unknown as (
            state: WithdrawalReservationLockedState,
          ) => Promise<void>,
          values.authorization,
          values.confirmation,
        ),
      ).rejects.toMatchObject({ status: 503, code: "WITHDRAWAL_UNAVAILABLE" });
      expect(values.tables.withdrawal_intent).toHaveLength(0);
    }
  });

  it.each(["withdrawal_intent", "financial_operation"])(
    "rolls back both records when %s insertion fails",
    async (table) => {
      const values = fixture();
      values.faults.failInsert = table;
      await denied(values, "WITHDRAWAL_UNAVAILABLE", 503);
      expect(values.tables.withdrawal_intent).toHaveLength(0);
      expect(values.tables.financial_operation).toHaveLength(0);
      expect(values.queries.some((query) => /^rollback/i.test(query.sql))).toBe(
        true,
      );
    },
  );

  it("rechecks database proof expiry after an insert before committing", async () => {
    const values = fixture();
    values.faults.onQuery = (text) => {
      if (/INSERT INTO "withdrawal_intent"/i.test(text))
        values.clock.sql = "2026-10-12T20:04:30.000001Z";
    };
    await denied(values, "RECENT_AUTH_REQUIRED", 403);
    expect(values.tables.withdrawal_intent).toHaveLength(0);
    expect(values.tables.financial_operation).toHaveLength(0);
  });

  it("recovers the same record after commit succeeds but acknowledgement is lost", async () => {
    const values = fixture();
    values.faults.commitAfterApplied = true;
    await denied(values, "WITHDRAWAL_UNAVAILABLE", 503, 1);
    expect(values.tables.withdrawal_intent).toHaveLength(1);
    values.faults.commitAfterApplied = false;
    values.account.isCurrent = false;
    values.destination.isCurrent = false;
    values.account.accountReference = "new-account-reference";
    values.clock.sql = "2026-10-12T20:02:00.000000Z";
    values.authorize.mockClear();
    values.queries.length = 0;
    const result = await createWithdrawalReservationRepository(
      values.db,
      values.options,
    ).reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    expect(result.intent).toEqual(values.snapshot.intent);
    expect(values.tables.withdrawal_intent).toHaveLength(1);
    expect(values.tables.financial_operation).toHaveLength(1);
    expect(
      values.queries.some((query) =>
        /AS "heldCents"|INSERT INTO|receiving_verification_evidence/i.test(
          query.sql,
        ),
      ),
    ).toBe(false);
    expect(values.authorize.mock.calls[0]?.[0]).toMatchObject({
      existingReservation: result,
      heldCents: null,
      unresolvedFinancialEventCount: null,
      balanceEffectsAfterObservationCount: null,
    });
  });

  it("replays UNKNOWN with a fresh current session without replacing the original snapshot", async () => {
    const values = fixture();
    const repository = createWithdrawalReservationRepository(
      values.db,
      values.options,
    );
    await repository.reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    Object.assign(values.tables.withdrawal_intent[0], { state: "UNKNOWN" });
    Object.assign(values.tables.financial_operation[0], { state: "UNKNOWN" });
    values.authorization.actor.sessionId = "session:fresh.2";
    values.authorization.recentAuth.sessionId = "session:fresh.2";
    values.storedSession.sessionId = "session:fresh.2";
    values.authorize.mockClear();
    const result = await repository.reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    expect(result.intent.state).toBe("UNKNOWN");
    expect(result.snapshot.authenticationAuditHash).toBe("a".repeat(64));
    expect(values.authorize.mock.calls[0]?.[0].currentSession?.sessionId).toBe(
      "session:fresh.2",
    );
    expect(values.tables.withdrawal_intent).toHaveLength(1);
  });

  it("returns an exact same-request race's original IDs, not candidate generated IDs", async () => {
    const values = fixture();
    const repository = createWithdrawalReservationRepository(
      values.db,
      values.options,
    );
    await repository.reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    const candidate = {
      ...values.snapshot,
      operationId: "unused-operation",
      intent: { ...values.snapshot.intent, id: "unused-withdrawal" },
    };
    const result = await repository.reserveWithdrawal(
      candidate,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    expect(result.snapshot).toEqual(values.snapshot);
    expect(values.tables.withdrawal_intent).toHaveLength(1);
  });

  it("rejects same-request collisions globally across account and environment", async () => {
    const values = fixture();
    const repository = createWithdrawalReservationRepository(
      values.db,
      values.options,
    );
    await repository.reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    const candidate = {
      ...values.snapshot,
      intent: {
        ...values.snapshot.intent,
        amountCents: 11_000,
        netCents: 10_500,
      },
    };
    candidate.requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          "site-1",
          "request-1",
          candidate.operatorUserId,
          "sandbox",
          11_000,
          3,
        ]),
      )
      .digest("hex");
    await expect(
      repository.reserveWithdrawal(
        candidate,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    const lookup = values.queries.find((query) =>
      /FROM "withdrawal_intent" w/.test(query.sql),
    );
    expect(lookup?.params).toEqual(["site-1", "request-1"]);
    expect(values.tables.withdrawal_intent).toHaveLength(1);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])(
    "does not infer unsupported %s execution from stored status",
    async (state) => {
      const values = fixture();
      const repository = createWithdrawalReservationRepository(
        values.db,
        values.options,
      );
      await repository.reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      );
      Object.assign(values.tables.withdrawal_intent[0], { state });
      await expect(
        repository.findByRequest("site-1", "request-1"),
      ).rejects.toMatchObject({ status: 503, code: "WITHDRAWAL_UNAVAILABLE" });
    },
  );

  it("reads real Drizzle raw timestamps and rejects sub-millisecond identity/time corruption", async () => {
    const values = fixture();
    const repository = createWithdrawalReservationRepository(
      values.db,
      values.options,
    );
    await repository.reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    );
    Object.assign(values.tables.withdrawal_intent[0], {
      createdAt: "2026-10-12 20:00:00.000000+00",
      updatedAt: "2026-10-12 20:00:00.000000+00",
    });
    Object.assign(values.tables.financial_operation[0], {
      createdAt: "2026-10-12 20:00:00.000000+00",
      updatedAt: "2026-10-12 20:00:00.000000+00",
    });
    await expect(
      repository.findByRequest("site-1", "request-1"),
    ).resolves.toEqual({
      snapshot: values.snapshot,
      intent: values.snapshot.intent,
    });
    Object.assign(values.tables.withdrawal_intent[0], {
      createdAt: "2026-10-12 20:00:00.000001+00",
    });
    await expect(
      repository.findByRequest("site-1", "request-1"),
    ).rejects.toMatchObject({ status: 503, code: "WITHDRAWAL_UNAVAILABLE" });
  });
});

describe("stored financial liability guards", () => {
  it("counts an actual UNKNOWN reservation in HELD exactly once", async () => {
    const values = fixture();
    values.budget.heldCents = "0";
    values.tables.withdrawal_intent.push({
      ...scope,
      id: "unknown-withdrawal",
      requestId: "other-request",
      state: "UNKNOWN",
      reservationState: "HELD",
      reservedCents: 10_000,
    });
    await denied(values, "INSUFFICIENT_FUNDS", 409, 1);
    expect(values.tables.financial_operation).toHaveLength(0);
  });

  it.each([
    "PAYMENT_RECEIVED",
    "CHECKOUT_PAID",
    "TRANSFER_DONE",
    "REFUND_DONE",
  ])("blocks an authenticated unresolved %s", async (eventType) => {
    const values = fixture();
    values.tables.financial_event_inbox.push({
      ...scope,
      eventType,
      authenticatedAt: now,
      state: "DEAD_LETTER",
    });
    await denied(values, "FINANCIAL_EVENTS_UNRESOLVED", 409);
  });

  it("blocks a stored UNKNOWN operation even when there is no pending inbox delivery", async () => {
    const values = fixture();
    values.tables.financial_operation.push({
      ...scope,
      id: "uncertain-operation",
      withdrawalIntentId: null,
      state: "UNKNOWN",
    });
    await denied(values, "FINANCIAL_EVENTS_UNRESOLVED", 409);
  });

  it.each([
    "REFUNDED",
    "CHARGEBACK_REQUESTED",
    "CHARGEBACK_DISPUTE",
    "CANCELLED",
    null,
  ])(
    "does not erase a restrictive observed payment %s from a provider balance",
    async (providerStatus) => {
      const values = fixture();
      values.tables.gift_payment_record.push({
        ...scope,
        id: "restricted-payment",
        providerStatus,
        verificationStatus: "VERIFIED",
      });
      await denied(values, "FINANCIAL_EVENTS_UNRESOLVED", 409);
    },
  );

  it.each(["2026-10-12T20:00:00.000000Z", "2026-10-12T20:00:00.000001Z"])(
    "blocks a ledger DEBIT at/after balance's lower-bound observation %s",
    async (createdAt) => {
      const values = fixture();
      values.tables.financial_ledger_entry.push({
        ...scope,
        direction: "DEBIT",
        createdAt,
      });
      await denied(values, "FINANCIAL_EVENTS_UNRESOLVED", 409);
    },
  );

  it("allows the fresh provider balance after a strictly earlier debit already reflected in that balance", async () => {
    const values = fixture();
    values.tables.financial_ledger_entry.push({
      ...scope,
      direction: "DEBIT",
      createdAt: "2026-10-12T19:59:59.999999Z",
    });
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).resolves.toMatchObject({ intent: { state: "REQUESTED" } });
    expect(
      values.authorize.mock.calls[0]?.[0].balanceEffectsAfterObservationCount,
    ).toBe(0);
  });

  it("keeps foreign scope, processed events and old reflected effects out of this account's sums", async () => {
    const values = fixture();
    values.tables.withdrawal_intent.push({
      ...scope,
      siteId: "other-site",
      id: "foreign-withdrawal",
      requestId: "other-request",
      state: "UNKNOWN",
      reservationState: "HELD",
      reservedCents: 2_147_483_647,
    });
    values.tables.financial_event_inbox.push({
      ...scope,
      eventType: "PAYMENT_RECEIVED",
      authenticatedAt: now,
      state: "PROCESSED",
    });
    values.tables.financial_event_inbox.push({
      ...scope,
      accountId: "other-account",
      eventType: "REFUND_DONE",
      authenticatedAt: now,
      state: "RETRY",
    });
    values.tables.financial_operation.push({
      ...scope,
      environment: "live",
      withdrawalIntentId: null,
      state: "UNKNOWN",
    });
    values.tables.financial_ledger_entry.push({
      ...scope,
      accountId: "other-account",
      direction: "DEBIT",
      createdAt: now,
    });
    await expect(
      createWithdrawalReservationRepository(
        values.db,
        values.options,
      ).reserveWithdrawal(
        values.snapshot,
        values.authorize,
        values.authorization,
        values.confirmation,
      ),
    ).resolves.toMatchObject({ intent: { state: "REQUESTED" } });
    expect(values.authorize.mock.calls[0]?.[0]).toMatchObject({
      heldCents: 5_000n,
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    });
  });
});

async function denied(
  values: ReturnType<typeof fixture>,
  code: string,
  status: number,
  storedCount = 0,
) {
  const error = await createWithdrawalReservationRepository(
    values.db,
    values.options,
  )
    .reserveWithdrawal(
      values.snapshot,
      values.authorize,
      values.authorization,
      values.confirmation,
    )
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code, status });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toMatch(
    /test-secret|password=|credential|provider-payer/,
  );
  expect(values.tables.withdrawal_intent).toHaveLength(storedCount);
}

function requestAttempt(
  values: ReturnType<typeof fixture>,
  requestId = values.snapshot.requestId,
) {
  return {
    actor: values.authorization.actor,
    access: {
      siteId: values.site.siteId,
      userId: values.authorization.actor.userId,
      membershipId: values.membership.id,
      membershipRole: "SITE_ADMIN",
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
    requestId,
  };
}
async function addRetainedWithdrawal(
  v: ReturnType<typeof fixture>,
  accountId: string,
  state: "UNKNOWN" | "REQUESTED" | "PROCESSING",
  operationState: "UNKNOWN" | "REQUESTED" | "PROCESSING",
) {
  const original = fixture();
  await createWithdrawalReservationRepository(
    original.db,
    original.options,
  ).reserveWithdrawal(
    original.snapshot,
    original.authorize,
    original.authorization,
    original.confirmation,
  );
  const intent = structuredClone(original.tables.withdrawal_intent[0]),
    operation = structuredClone(original.tables.financial_operation[0]);
  const snapshot = { ...structuredClone(original.snapshot) };
  snapshot.requestId = "historical-request";
  snapshot.operationId = "historical-operation";
  snapshot.accountId = accountId;
  snapshot.accountReference =
    accountId === v.account.id ? v.account.accountReference : "acct_old";
  snapshot.recipientReference =
    accountId === v.account.id ? v.account.recipientReference : "wallet_old";
  snapshot.bankReference =
    accountId === v.account.id ? v.destination.bankReference : "bank-old";
  snapshot.intent = {
    ...snapshot.intent,
    id: "historical-withdrawal",
    amountCents: 1000,
    feeCents: 500,
    netCents: 500,
  };
  snapshot.requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        "withdrawal.reservation.v1",
        snapshot.intent.siteId,
        snapshot.requestId,
        snapshot.operatorUserId,
        snapshot.environment,
        snapshot.intent.amountCents,
        snapshot.intent.destinationVersion,
      ]),
    )
    .digest("hex");
  Object.assign(intent, {
    id: snapshot.intent.id,
    accountId,
    requestId: snapshot.requestId,
    requestHash: snapshot.requestHash,
    amountCents: 1000,
    feeCents: 500,
    netCents: 500,
    reservedCents: 1000,
    state,
  });
  Object.assign(operation, {
    id: snapshot.operationId,
    accountId,
    requestId: snapshot.requestId,
    requestHash: snapshot.requestHash,
    requestSnapshot: snapshot,
    withdrawalIntentId: snapshot.intent.id,
    state: operationState,
  });
  if (operationState === "PROCESSING")
    Object.assign(operation, {
      attempts: 1,
      leaseOwner: "historical-worker",
      leaseToken: "historical-lease",
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
  if (accountId !== v.account.id)
    v.tables.receiving_account.push({
      ...v.account,
      id: accountId,
      accountReference: snapshot.accountReference,
      recipientReference: snapshot.recipientReference,
      isCurrent: false,
    });
  v.tables.withdrawal_intent.push(intent);
  v.tables.financial_operation.push(operation);
  return { intent, operation };
}
describe("durable withdrawal request lifecycle", () => {
  it("rereads an issued payout consent after PostgreSQL JSONB reorders nested keys without changing its hash", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.jsonbRoundTrip = true;
    const payout = {
      destinationId: "payout-1",
      destinationVersion: 2,
      configurationHash: "a".repeat(64),
      reviewId: "review-1",
      holderId: "holder-record-1",
      holderConsentId: "holder-consent-1",
      acceptThirdParty: true,
      keyType: "EMAIL" as const,
      maskedKey: "c***@p***",
      ownerName: "Sandbox Recipient",
    };
    const maskedDestination = `Pix ${payout.keyType}: ${payout.maskedKey}`;
    Object.assign(v.presentation, { payout, maskedDestination });
    const consent = readWithdrawalConsentSnapshot({
      ...v.consentSnapshot,
      preview: {
        ...v.consentSnapshot.preview,
        maskedDestination,
        payoutRecipientName: payout.ownerName,
      },
      presentation: {
        ...v.consentSnapshot.presentation,
        payout,
        maskedDestination,
      },
    });
    const originalHash = hashWithdrawalConsentSnapshot(consent);
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(
      await repo.issuePreview?.(consent, "0", requestAttempt(v)),
    ).toMatchObject({ state: "OPEN", preview: consent.preview });
    const reread = await repo.findConsent?.(requestAttempt(v));
    expect(reread?.previewHash).toBe(originalHash);
    expect(reread?.snapshot).toEqual(consent);
    const stored = v.tables.withdrawal_request[0];
    expect(
      Object.keys(
        (stored.previewSnapshot as typeof consent).presentation.payout ?? {},
      ),
    ).not.toEqual(Object.keys(payout));
    expect(stored.previewHash).toBe(originalHash);
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
    const storedPayout = (stored.previewSnapshot as typeof consent).presentation
      .payout;
    if (!storedPayout) throw new Error("Missing stored payout");
    storedPayout.configurationHash = "b".repeat(64);
    await expect(repo.findConsent?.(requestAttempt(v))).rejects.toMatchObject({
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    });
  });

  it.each(["readRequest", "readContext"] as const)(
    "keeps %s available after a local wall-clock correction while SQL time remains valid",
    async (method) => {
      const v = fixture();
      v.tables.withdrawal_request.length = 0;
      v.faults.onQuery = (text) => {
        if (text.includes('FROM "site" st'))
          v.clock.app = new Date(now.getTime() - 434);
      };
      const repo = createWithdrawalReservationRepository(v.db, v.options);
      const result = await repo[method]?.(requestAttempt(v));
      expect(result).toMatchObject(
        method === "readRequest"
          ? { state: "UNRESOLVED", command: null }
          : { newRequestAllowed: true, reason: null },
      );
      expect(v.queries.some((query) => /^commit/i.test(query.sql))).toBe(true);
      expect(
        v.queries.some((query) => /^(INSERT|UPDATE|DELETE)/i.test(query.sql)),
      ).toBe(false);
    },
  );

  it("still rejects a regressing SQL clock during a read after local wall-clock correction", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.onQuery = (text) => {
      if (text.includes('FROM "site" st')) {
        v.clock.app = new Date(now.getTime() - 434);
        v.clock.sql = "2026-10-12 19:59:59.999999+00";
      }
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).readRequest?.(
        requestAttempt(v),
      ),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE", status: 503 });
  });

  it("still checks SQL session expiry after a local wall-clock correction", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.onQuery = (text) => {
      if (text.includes('FROM "site" st'))
        v.clock.app = new Date(now.getTime() - 434);
      if (text.includes("SUM(r.request_revision)"))
        v.clock.sql = v.storedSession.sessionExpiresAt;
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).readRequest?.(
        requestAttempt(v),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED", status: 403 });
  });

  it.each(["readRequest", "issuePreview"] as const)(
    "does not let %s revive a session expired at the earlier local high-water mark",
    async (method) => {
      const v = fixture();
      v.tables.withdrawal_request.length = 0;
      v.faults.onQuery = (text) => {
        if (text.includes('FROM "site" st'))
          v.clock.app = new Date(now.getTime() + 86_400_000);
        if (text.includes('FROM "session" se')) v.clock.app = new Date(now);
      };
      const repo = createWithdrawalReservationRepository(v.db, v.options);
      await expect(
        method === "readRequest"
          ? repo.readRequest?.(requestAttempt(v))
          : repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v)),
      ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED", status: 403 });
      expect(v.tables.withdrawal_request).toHaveLength(0);
    },
  );

  it("issues a preview after local wall-clock correction while retaining SQL authorization checks", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.onQuery = (text) => {
      if (text.includes('FROM "site" st'))
        v.clock.app = new Date(now.getTime() - 434);
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).issuePreview?.(
        v.consentSnapshot,
        "0",
        requestAttempt(v),
      ),
    ).resolves.toMatchObject({ state: "OPEN" });
    expect(v.tables.withdrawal_request).toHaveLength(1);
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });

  it("reserves the original consent after local wall-clock correction without changing its identity or terms", async () => {
    const v = fixture();
    v.faults.onQuery = (text) => {
      if (text.includes('FROM "site" st'))
        v.clock.app = new Date(now.getTime() - 434);
    };
    const originalHash = v.snapshot.requestHash;
    const result = await createWithdrawalReservationRepository(
      v.db,
      v.options,
    ).reserveWithdrawal(
      v.snapshot,
      v.authorize,
      v.authorization,
      v.confirmation,
    );
    expect(result.snapshot).toEqual(v.snapshot);
    expect(result.snapshot.requestHash).toBe(originalHash);
    expect(v.tables.withdrawal_request[0].state).toBe("COMMITTED");
    expect(v.tables.withdrawal_intent).toHaveLength(1);
    expect(v.tables.financial_operation).toHaveLength(1);
  });

  it.each([
    ["proof", "2026-10-12T20:04:30.000001Z", "RECENT_AUTH_REQUIRED", 403],
    ["session", "2026-10-12T20:00:01.000000Z", "MEMBERSHIP_DENIED", 403],
    ["fee", "2026-10-12T20:01:00.000001Z", "FEE_QUOTE_UNAVAILABLE", 409],
  ] as const)(
    "does not revive an expired %s when local time recedes and SQL time advances",
    async (kind, sqlTime, code, status) => {
      const v = fixture();
      v.faults.onQuery = (text) => {
        if (text.includes('FROM "site" st'))
          v.clock.app = new Date(now.getTime() - 434);
      };
      if (kind === "session")
        v.storedSession.sessionExpiresAt = "2026-10-12T20:00:01.000000Z";
      v.faults.callbackClock = sqlTime;
      await expect(
        createWithdrawalReservationRepository(
          v.db,
          v.options,
        ).reserveWithdrawal(
          v.snapshot,
          v.authorize,
          v.authorization,
          v.confirmation,
        ),
      ).rejects.toMatchObject({ code, status });
      expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
      expect(v.tables.withdrawal_intent).toHaveLength(0);
      expect(v.tables.financial_operation).toHaveLength(0);
    },
  );

  it.each(["issuePreview", "reserveWithdrawal"] as const)(
    "still rejects a regressing SQL clock during %s after local correction",
    async (method) => {
      const v = fixture();
      let clockReads = 0;
      v.faults.onQuery = (text) => {
        if (text.includes('FROM "site" st'))
          v.clock.app = new Date(now.getTime() - 434);
        if (text.includes("SELECT clock_timestamp()") && ++clockReads === 2)
          v.clock.sql = "2026-10-12T19:59:59.999999Z";
      };
      const repo = createWithdrawalReservationRepository(v.db, v.options);
      if (method === "issuePreview") v.tables.withdrawal_request.length = 0;
      await expect(
        method === "issuePreview"
          ? repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v))
          : repo.reserveWithdrawal(
              v.snapshot,
              v.authorize,
              v.authorization,
              v.confirmation,
            ),
      ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE", status: 503 });
      expect(v.tables.withdrawal_intent).toHaveLength(0);
      expect(v.tables.financial_operation).toHaveLength(0);
    },
  );

  it("still rejects proof in the future of SQL time when the local clock is valid and later recedes", async () => {
    const v = fixture();
    v.authorization.recentAuth.authenticatedAt = new Date(now.getTime() - 500);
    v.clock.sql = "2026-10-12T19:59:59.000000Z";
    v.faults.onQuery = (text) => {
      if (text.includes('FROM "site" st'))
        v.clock.app = new Date(now.getTime() - 434);
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED", status: 403 });
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });

  it.each([new Date(Number.NaN), "2026-10-12 20:00:00+00"])(
    "still rejects an invalid or non-Date local read clock %#",
    async (value) => {
      const v = fixture();
      Object.assign(v.options, { now: () => value });
      await expect(
        createWithdrawalReservationRepository(v.db, v.options).readRequest?.(
          requestAttempt(v),
        ),
      ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE", status: 503 });
      expect(v.query).not.toHaveBeenCalled();
    },
  );

  it.each(["historical-account", "account-1"])(
    "blocks a NEW hold for the same operator's UNKNOWN intent in %s even when its operation is REQUESTED",
    async (accountId) => {
      const v = fixture();
      v.budget.heldCents = "0";
      await addRetainedWithdrawal(v, accountId, "UNKNOWN", "REQUESTED");
      await expect(
        createWithdrawalReservationRepository(
          v.db,
          v.options,
        ).reserveWithdrawal(
          v.snapshot,
          v.authorize,
          v.authorization,
          v.confirmation,
        ),
      ).rejects.toMatchObject({
        code: "FINANCIAL_EVENTS_UNRESOLVED",
        status: 409,
      });
      expect(v.tables.withdrawal_intent).toHaveLength(1);
      expect(v.tables.financial_operation).toHaveLength(1);
      expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
      expect(v.authorize).not.toHaveBeenCalled();
    },
  );
  it("blocks a historical UNKNOWN operation in the complete owned scope before a NEW hold", async () => {
    const v = fixture();
    await addRetainedWithdrawal(v, "historical-account", "UNKNOWN", "UNKNOWN");
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({
      code: "FINANCIAL_EVENTS_UNRESOLVED",
      status: 409,
    });
    expect(v.tables.withdrawal_intent).toHaveLength(1);
  });
  it.each(["REQUESTED", "PROCESSING"] as const)(
    "preserves known %s commitments within the actual available budget",
    async (state) => {
      const v = fixture();
      v.budget.heldCents = "0";
      await addRetainedWithdrawal(v, v.account.id, state, state);
      expect(
        await createWithdrawalReservationRepository(
          v.db,
          v.options,
        ).reserveWithdrawal(
          v.snapshot,
          v.authorize,
          v.authorization,
          v.confirmation,
        ),
      ).toMatchObject({ intent: v.snapshot.intent });
      expect(v.tables.withdrawal_intent).toHaveLength(2);
    },
  );
  it("rechecks owned scope uncertainty after the awaited authorization callback", async () => {
    const v = fixture();
    v.budget.heldCents = "0";
    const old = await addRetainedWithdrawal(
      v,
      "historical-account",
      "REQUESTED",
      "REQUESTED",
    );
    v.authorize.mockImplementation(async () => {
      old.intent.state = "UNKNOWN";
    });
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({
      code: "FINANCIAL_EVENTS_UNRESOLVED",
      status: 409,
    });
    expect(v.tables.withdrawal_intent).toHaveLength(1);
    expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
  });
  it("rolls back both new financial rows if historical uncertainty appears after the first insert", async () => {
    const v = fixture();
    v.budget.heldCents = "0";
    const old = await addRetainedWithdrawal(
      v,
      "historical-account",
      "REQUESTED",
      "REQUESTED",
    );
    v.faults.onQuery = (text) => {
      if (/^insert into "withdrawal_intent"/i.test(text))
        old.intent.state = "UNKNOWN";
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({
      code: "FINANCIAL_EVENTS_UNRESOLVED",
      status: 409,
    });
    expect(v.tables.withdrawal_intent).toHaveLength(1);
    expect(v.tables.financial_operation).toHaveLength(1);
    expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
  });
  it("preserves replay, recovery and seal of the original reservation despite another historical UNKNOWN", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    const original = await repo.reserveWithdrawal(
      v.snapshot,
      v.authorize,
      v.authorization,
      v.confirmation,
    );
    await addRetainedWithdrawal(
      v,
      "historical-account",
      "UNKNOWN",
      "REQUESTED",
    );
    v.account.isCurrent = false;
    v.destination.isCurrent = false;
    v.options.loadVerifiedPresentationInTransaction.mockClear();
    const before = v.queries.filter((q) =>
      /AS "scopeUnresolvedCount"/.test(q.sql),
    ).length;
    expect(
      await repo.reserveWithdrawal(v.snapshot, v.authorize, v.authorization),
    ).toEqual(original);
    expect(
      await repo.recoverWithdrawal?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toEqual(original);
    expect(
      await repo.sealUncreatedRequest?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toMatchObject({ state: "EXISTING", withdrawal: original.intent });
    expect(
      v.queries.filter((q) => /AS "scopeUnresolvedCount"/.test(q.sql)),
    ).toHaveLength(before);
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
    expect(v.tables.withdrawal_intent).toHaveLength(2);
  });
  it("records the actual SQL creation microseconds without changing the issued immutable preview", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.clock.sql = "2026-10-12 20:00:00.000001+00";
    const created = await createWithdrawalReservationRepository(
      v.db,
      v.options,
    ).issuePreview?.(v.consentSnapshot, "0", requestAttempt(v));
    expect(created).toMatchObject({
      state: "OPEN",
      preview: v.consentSnapshot.preview,
      observationOrder: {
        recordUpdatedAtMicroseconds: (
          databaseTimestampEpochMicroseconds(now) + 1n
        ).toString(),
      },
    });
    expect(
      databaseTimestampEpochMicroseconds(
        v.tables.withdrawal_request[0].createdAt,
      ),
    ).toBe(databaseTimestampEpochMicroseconds(v.clock.sql));
  });
  it("withholds withdrawal context for a demo destination carrying simulated evidence", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.evidence.provenance = "SIMULATION";
    Object.assign(v.presentation, { provenance: "simulation" });
    const context = await createWithdrawalReservationRepository(
      v.db,
      v.options,
    ).readContext?.(requestAttempt(v));
    expect(context).toMatchObject({
      newRequestAllowed: false,
      reason: "DESTINATION_UNAVAILABLE",
    });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
  });
  it("rejects simulated evidence again inside the reservation transaction before presentation or hold writes", async () => {
    const v = fixture();
    v.evidence.provenance = "SIMULATION";
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "DESTINATION_UNVERIFIED" });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });
  it("rejects presentation provenance that disagrees with its selected authenticated evidence", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.evidence.provenance = "SIMULATION";
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).readContext?.(
        requestAttempt(v),
      ),
    ).resolves.toMatchObject({
      newRequestAllowed: false,
      reason: "DESTINATION_UNAVAILABLE",
    });
  });
  it("rejects a future sub-millisecond account observation before issuing OPEN", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.account.observedAt = "2026-10-12 20:00:00.000001+00" as unknown as Date;
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).issuePreview?.(
        v.consentSnapshot,
        "0",
        requestAttempt(v),
      ),
    ).rejects.toMatchObject({ code: "DESTINATION_UNVERIFIED", status: 409 });
    expect(v.tables.withdrawal_request).toHaveLength(0);
  });
  it("paginates only after complete scope aggregation and supports exact discovery beyond the page", async () => {
    const v = fixture();
    const template = v.tables.withdrawal_request[0];
    v.tables.withdrawal_request.length = 0;
    for (let index = 0; index < 101; index++) {
      const requestId = `sealed-${String(index).padStart(3, "0")}`;
      const snapshot = readWithdrawalConsentSnapshot({
        ...v.consentSnapshot,
        preview: { ...v.consentSnapshot.preview, requestId },
      });
      v.tables.withdrawal_request.push({
        ...template,
        id: `row-${index}`,
        requestId,
        previewSnapshot: snapshot,
        previewHash: hashWithdrawalConsentSnapshot(snapshot),
        state: "SEALED_NOT_CREATED",
        requestRevision: 2n,
        sealedAt: now.toISOString(),
      });
    }
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    const first = await repo.readContext?.(requestAttempt(v));
    expect(first).toMatchObject({
      scopeRevision: "202",
      newRequestAllowed: true,
      nextCursor: "wc1:sealed-099",
    });
    expect(first?.recoverableRequests).toHaveLength(100);
    const second = await repo.readContext?.({
      ...requestAttempt(v),
      cursor: first?.nextCursor ?? undefined,
    });
    expect(second?.recoverableRequests.map((row) => row.requestId)).toEqual([
      "sealed-100",
    ]);
    expect(second?.nextCursor).toBeNull();
    expect(
      await repo.readRequest?.(requestAttempt(v, "sealed-100")),
    ).toMatchObject({ state: "SEALED_NOT_CREATED", scopeRevision: "202" });
    expect(v.queries.filter((q) => /^SELECT w\.id/i.test(q.sql))).toHaveLength(
      3,
    );
  });
  it.each(["seal-first", "confirm-first"])(
    "serializes %s winners without another hold or release",
    async (order) => {
      const v = fixture();
      let tail = Promise.resolve();
      const serialized: WithdrawalReservationDatabase = {
        execute: v.db.execute.bind(v.db),
        transaction<T>(
          callback: (tx: ReceivingTransaction) => Promise<T>,
          config?: Parameters<typeof v.db.transaction>[1],
        ): Promise<T> {
          const work = tail.then(() => v.db.transaction(callback, config));
          tail = work.then(
            () => undefined,
            () => undefined,
          );
          return work;
        },
      };
      const repo = createWithdrawalReservationRepository(serialized, v.options);
      const confirm = () =>
        repo.reserveWithdrawal(
          v.snapshot,
          v.authorize,
          v.authorization,
          v.confirmation,
        );
      const seal = () => repo.sealUncreatedRequest?.(requestAttempt(v));
      const results = await Promise.allSettled(
        order === "seal-first" ? [seal(), confirm()] : [confirm(), seal()],
      );
      if (order === "seal-first") {
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { state: "SEALED_NOT_CREATED" },
        });
        expect(results[1]).toMatchObject({
          status: "rejected",
          reason: { code: "REQUEST_CONFLICT" },
        });
        expect(v.tables.withdrawal_intent).toHaveLength(0);
      } else {
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { intent: v.snapshot.intent },
        });
        expect(results[1]).toMatchObject({
          status: "fulfilled",
          value: { state: "EXISTING" },
        });
        expect(v.tables.withdrawal_intent).toHaveLength(1);
      }
      expect(v.tables.financial_operation).toHaveLength(
        order === "seal-first" ? 0 : 1,
      );
      expect(v.tables.withdrawal_request[0].requestRevision).toBe(2n);
    },
  );
  it("rolls back the hold and operation if final OPEN association CAS loses", async () => {
    const v = fixture();
    v.faults.onQuery = (text) => {
      if (/^UPDATE "withdrawal_request" r/.test(text))
        v.tables.withdrawal_request[0].state = "SEALED_NOT_CREATED";
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
    expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
  });
  it("discovers legacy existing requests without fabricating a preview or requiring current READY", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    await repo.reserveWithdrawal(
      v.snapshot,
      v.authorize,
      v.authorization,
      v.confirmation,
    );
    v.tables.withdrawal_request.length = 0;
    v.account.isCurrent = false;
    v.destination.isCurrent = false;
    v.options.loadVerifiedPresentationInTransaction.mockClear();
    expect(await repo.readRequest?.(requestAttempt(v))).toMatchObject({
      state: "EXISTING",
      preview: null,
      requestRevision: null,
      scopeRevision: "0",
      observationOrder: {
        recordUpdatedAtMicroseconds:
          databaseTimestampEpochMicroseconds(now).toString(),
      },
    });
    expect(
      await repo.recoverWithdrawal?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toMatchObject({ intent: v.snapshot.intent });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
  });
  it("preserves UNKNOWN holds on seal and blocks eligibility even beyond an empty page", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    await repo.reserveWithdrawal(
      v.snapshot,
      v.authorize,
      v.authorization,
      v.confirmation,
    );
    v.tables.withdrawal_intent[0].state = "UNKNOWN";
    v.tables.financial_operation[0].state = "UNKNOWN";
    v.account.isCurrent = false;
    expect(
      await repo.sealUncreatedRequest?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toMatchObject({ state: "EXISTING", withdrawal: { state: "UNKNOWN" } });
    expect(v.tables.withdrawal_intent[0].reservationState).toBe("HELD");
    expect(
      await repo.readContext?.({ ...requestAttempt(v), cursor: "wc1:zzzz" }),
    ).toMatchObject({
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
      recoverableRequests: [],
    });
  });
  it.each([
    "missing",
    "unsafeMask",
    "rawAccount",
    "foreignScope",
    "wrongDestination",
    "wrongEvidence",
    "wrongProfile",
    "credential",
    "throw",
  ])(
    "denies empty-context affordance for %s presentation without effects",
    async (kind) => {
      const v = fixture();
      v.tables.withdrawal_request.length = 0;
      v.options.loadVerifiedPresentationInTransaction.mockImplementation(
        async () => {
          if (kind === "missing")
            return null as unknown as typeof v.presentation;
          if (kind === "throw") throw new Error("password=test-secret");
          const { amountCents: _, currency: __, ...stored } = v.presentation;
          const changes: Record<string, unknown> = {
            unsafeMask: { maskedDestination: "Bank 1234" },
            rawAccount: { maskedDestination: "123456789012" },
            foreignScope: { siteId: "other-site" },
            wrongDestination: { destinationId: "other-destination" },
            wrongEvidence: { evidenceId: "other-evidence" },
            wrongProfile: { operatorDisplayName: "Foreign Operator" },
            credential: { apiKey: "test-secret" },
          };
          return {
            ...stored,
            ...(changes[kind] as object),
          } as typeof v.presentation;
        },
      );
      const result = await createWithdrawalReservationRepository(
        v.db,
        v.options,
      )
        .readContext?.(requestAttempt(v))
        .catch((error) => error);
      if (kind === "missing")
        expect(result).toMatchObject({
          newRequestAllowed: false,
          reason: "DESTINATION_UNAVAILABLE",
        });
      else {
        expect(result).toMatchObject({
          code: "WITHDRAWAL_UNAVAILABLE",
          status: 503,
        });
        expect(JSON.stringify(result)).not.toContain("test-secret");
      }
      expect(
        v.queries.every(
          (q) =>
            !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE)/i.test(
              q.sql,
            ),
        ),
      ).toBe(true);
    },
  );
  it.each([
    "staleBank",
    "futureBank",
    "futureMicroAccount",
    "foreignOperator",
    "unready",
  ])("denies empty-context eligibility for actual %s state", async (kind) => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    if (kind === "staleBank")
      v.evidence.bankObservedAt = new Date(now.getTime() - 60001);
    else if (kind === "futureBank")
      v.evidence.bankObservedAt = new Date(now.getTime() + 1);
    else if (kind === "futureMicroAccount")
      v.account.observedAt = "2026-10-12 20:00:00.000001+00" as unknown as Date;
    else if (kind === "foreignOperator")
      v.account.operatorUserId = "other-user";
    else v.evidence.withdrawalCapability = false;
    const result = await createWithdrawalReservationRepository(
      v.db,
      v.options,
    ).readContext?.(requestAttempt(v));
    expect(result).toMatchObject({
      newRequestAllowed: false,
      reason:
        kind === "foreignOperator"
          ? "RECIPIENT_REQUIRED"
          : "DESTINATION_UNAVAILABLE",
    });
  });
  it("accepts an unchanged old operator profile and raw PostgreSQL evidence timestamps", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.storedUser.operatorProfileUpdatedAt = new Date(
      "2026-01-01T00:00:00.000Z",
    );
    v.presentation.operatorProfileUpdatedAt =
      v.storedUser.operatorProfileUpdatedAt;
    v.account.observedAt = "2026-10-12 19:59:59.999999+00" as unknown as Date;
    v.evidence.observedAt = "2026-10-12 19:59:59.999999+00" as unknown as Date;
    v.evidence.bankObservedAt = v.evidence.observedAt;
    const normalized = readDatabaseTimestamp(v.evidence.observedAt);
    v.presentation.evidenceObservedAt = normalized;
    v.presentation.bankObservedAt = normalized;
    expect(
      await createWithdrawalReservationRepository(
        v.db,
        v.options,
      ).readContext?.(requestAttempt(v)),
    ).toMatchObject({ newRequestAllowed: true, reason: null });
  });
  it("keeps whole-scope unresolved financial evidence visible before pagination", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.tables.financial_event_inbox.push({
      ...scope,
      eventType: "REFUND_PENDING",
      authenticatedAt: now,
      state: "RETRY",
    });
    expect(
      await createWithdrawalReservationRepository(
        v.db,
        v.options,
      ).readContext?.({ ...requestAttempt(v), cursor: "wc1:zzzz" }),
    ).toMatchObject({
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
      recoverableRequests: [],
    });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
  });
  it("retains expired OPEN discovery and blocks another issue until explicit seal", async () => {
    const v = fixture();
    v.clock.sql = "2026-10-12 20:01:00.000000+00";
    v.clock.app = new Date(now.getTime() + 60000);
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(await repo.readContext?.(requestAttempt(v))).toMatchObject({
      reason: "OPEN_REQUEST",
      openRequest: { state: "OPEN", preview: v.consentSnapshot.preview },
    });
    const next = readWithdrawalConsentSnapshot({
      ...v.consentSnapshot,
      preview: { ...v.consentSnapshot.preview, requestId: "another-request" },
    });
    await expect(
      repo.issuePreview?.(next, "1", requestAttempt(v, "another-request")),
    ).rejects.toMatchObject({
      code: "FINANCIAL_EVENTS_UNRESOLVED",
      status: 409,
    });
    expect(v.tables.withdrawal_request).toHaveLength(1);
    expect(v.tables.withdrawal_intent).toHaveLength(0);
  });
  it("uses scope revisions of all retained actors without exposing their private requests", async () => {
    const v = fixture();
    const snapshot = readWithdrawalConsentSnapshot({
      ...v.consentSnapshot,
      operatorUserId: "foreign-operator",
      presentation: {
        ...v.consentSnapshot.presentation,
        operatorUserId: "foreign-operator",
      },
      preview: { ...v.consentSnapshot.preview, requestId: "foreign-request" },
    });
    v.tables.withdrawal_request.push({
      ...v.tables.withdrawal_request[0],
      id: "foreign-row",
      operatorUserId: "foreign-operator",
      requestId: "foreign-request",
      previewSnapshot: snapshot,
      previewHash: hashWithdrawalConsentSnapshot(snapshot),
    });
    const context = await createWithdrawalReservationRepository(
      v.db,
      v.options,
    ).readContext?.(requestAttempt(v));
    expect(context).toMatchObject({
      scopeRevision: "2",
      openRequest: { requestId: v.snapshot.requestId },
      recoverableRequests: [],
    });
    expect(JSON.stringify(context)).not.toContain("foreign-request");
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).readRequest?.(
        requestAttempt(v, "foreign-request"),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
  });
  it("rejects stale scope before locked presentation I/O", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    await expect(
      repo.issuePreview?.(v.consentSnapshot, "1", requestAttempt(v)),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
    expect(v.tables.withdrawal_request).toHaveLength(0);
  });
  it("recovers issued preview after a lost commit acknowledgement without reissuing", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.commitAfterApplied = true;
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    await expect(
      repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v)),
    ).rejects.toMatchObject({ status: 503, code: "WITHDRAWAL_UNAVAILABLE" });
    expect(v.tables.withdrawal_request).toHaveLength(1);
    v.faults.commitAfterApplied = false;
    v.options.loadVerifiedPresentationInTransaction.mockClear();
    v.account.isCurrent = false;
    expect(
      await repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v)),
    ).toMatchObject({ state: "OPEN", scopeRevision: "1" });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
    expect(v.tables.withdrawal_request).toHaveLength(1);
  });
  it("rolls back preview issuance when its proof-independent session expires during insert", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.faults.onQuery = (text) => {
      if (/^INSERT INTO "withdrawal_request"/.test(text))
        v.clock.sql = "2026-10-13 20:00:00.000000+00";
    };
    await expect(
      createWithdrawalReservationRepository(v.db, v.options).issuePreview?.(
        v.consentSnapshot,
        "0",
        requestAttempt(v),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED", status: 403 });
    expect(v.tables.withdrawal_request).toHaveLength(0);
    expect(v.tables.withdrawal_intent).toHaveLength(0);
  });
  it("recovers a committed seal after a lost acknowledgement and denies all late confirmation", async () => {
    const v = fixture();
    v.faults.commitAfterApplied = true;
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    const attempt = {
      ...requestAttempt(v),
      recentAuth: v.authorization.recentAuth,
    };
    await expect(repo.sealUncreatedRequest?.(attempt)).rejects.toMatchObject({
      code: "WITHDRAWAL_UNAVAILABLE",
      status: 503,
    });
    expect(v.tables.withdrawal_request[0].state).toBe("SEALED_NOT_CREATED");
    v.faults.commitAfterApplied = false;
    const writes = v.queries.filter((q) => /^UPDATE/.test(q.sql)).length;
    expect(await repo.sealUncreatedRequest?.(attempt)).toMatchObject({
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
    });
    expect(v.queries.filter((q) => /^UPDATE/.test(q.sql))).toHaveLength(writes);
    await expect(
      repo.reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
  });
  it("does not seal an orphan financial operation or unknown identifier", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    const missing = {
      ...requestAttempt(v, "unknown-request"),
      recentAuth: v.authorization.recentAuth,
    };
    expect(await repo.sealUncreatedRequest?.(missing)).toMatchObject({
      state: "UNRESOLVED",
      command: null,
    });
    expect(v.tables.withdrawal_request).toHaveLength(1);
    v.tables.financial_operation.push({
      id: "orphan-operation",
      ...scope,
      kind: "WITHDRAWAL",
      requestId: v.snapshot.requestId,
      withdrawalIntentId: null,
    });
    await expect(
      repo.sealUncreatedRequest?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_UNAVAILABLE", status: 503 });
    expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
  });
  it.each(["revoked", "wrongSession"])(
    "requires current session authority for seal/recovery: %s",
    async (kind) => {
      const v = fixture();
      if (kind === "revoked") v.membership.revokedAt = now as unknown as null;
      else v.storedSession.sessionId = "other-session";
      const repo = createWithdrawalReservationRepository(v.db, v.options);
      for (const action of [repo.sealUncreatedRequest, repo.recoverWithdrawal])
        await expect(
          action?.({
            ...requestAttempt(v),
            recentAuth: v.authorization.recentAuth,
          }),
        ).rejects.toMatchObject({ status: 403 });
      expect(v.tables.withdrawal_request[0].state).toBe("OPEN");
      expect(v.tables.withdrawal_intent).toHaveLength(0);
    },
  );
  it("ignores an expired legacy proof only for closing while recovery still requires fresh proof", async () => {
    const v = fixture();
    v.clock.sql = "2026-10-12 20:04:30.000000+00";
    v.clock.app = new Date(now.getTime() + 270000);
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    const attempt = {
      ...requestAttempt(v),
      recentAuth: v.authorization.recentAuth,
    };
    await expect(repo.recoverWithdrawal?.(attempt)).rejects.toMatchObject({
      status: 403,
    });
    expect(await repo.sealUncreatedRequest?.(attempt)).toMatchObject({
      state: "SEALED_NOT_CREATED",
    });
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });
  it("allows an empty context only from amount-less exact stored presentation evidence", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    v.options.loadVerifiedPresentationInTransaction.mockImplementation(
      async () => {
        const {
          amountCents: _,
          currency: __,
          ...presentation
        } = v.presentation;
        return presentation as typeof v.presentation;
      },
    );
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(await repo.readContext?.(requestAttempt(v))).toMatchObject({
      newRequestAllowed: true,
      reason: null,
      scopeRevision: "0",
      openRequest: null,
      recoverableRequests: [],
    });
    const scope =
      v.options.loadVerifiedPresentationInTransaction.mock.calls[0]?.[1];
    expect(scope).toEqual({
      siteId: v.site.siteId,
      accountId: v.account.id,
      accountReference: v.account.accountReference,
      environment: "sandbox",
      bankReference: v.destination.bankReference,
      destinationVersion: v.destination.version,
    });
    expect(
      v.queries.every(
        (q) =>
          !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE)/i.test(
            q.sql,
          ),
      ),
    ).toBe(true);
  });
  it("discovers OPEN before any withdrawal row in a read-only scope snapshot", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(await repo.readContext?.(requestAttempt(v))).toMatchObject({
      scopeRevision: "1",
      newRequestAllowed: false,
      reason: "OPEN_REQUEST",
      openRequest: {
        state: "OPEN",
        requestId: v.snapshot.requestId,
        requestRevision: "1",
      },
      recoverableRequests: [],
    });
    expect(v.queries[0].sql).toMatch(
      /begin isolation level repeatable read read only/i,
    );
    expect(
      v.queries.every(
        (q) =>
          !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE)/i.test(
            q.sql,
          ),
      ),
    ).toBe(true);
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
  });
  it("reads the exact immutable request and keeps missing identifiers unresolved", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(await repo.readRequest?.(requestAttempt(v))).toMatchObject({
      state: "OPEN",
      preview: v.consentSnapshot.preview,
      requestRevision: "1",
      scopeRevision: "1",
      observationOrder: {
        recordUpdatedAtMicroseconds:
          databaseTimestampEpochMicroseconds(now).toString(),
      },
    });
    expect(
      await repo.readRequest?.(requestAttempt(v, "missing-request")),
    ).toMatchObject({
      state: "UNRESOLVED",
      command: null,
      requestRevision: null,
      scopeRevision: "1",
      observationOrder: { recordUpdatedAtMicroseconds: null },
    });
  });
  it("issues one durable preview without hold/operation and retains it on retry", async () => {
    const v = fixture();
    v.tables.withdrawal_request.length = 0;
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(
      await repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v)),
    ).toMatchObject({
      state: "OPEN",
      requestRevision: "1",
      scopeRevision: "1",
      preview: v.consentSnapshot.preview,
    });
    expect(
      await repo.issuePreview?.(v.consentSnapshot, "0", requestAttempt(v)),
    ).toMatchObject({ state: "OPEN", scopeRevision: "1" });
    expect(v.tables.withdrawal_request).toHaveLength(1);
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });
  it("seals an expired owned OPEN without proof or financial effects and permanently denies late confirmation", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    v.clock.sql = "2026-10-12 20:04:30.000000+00";
    v.clock.app = new Date(now.getTime() + 270000);
    const attempt = requestAttempt(v);
    const sealed = await repo.sealUncreatedRequest?.(attempt);
    expect(sealed).toMatchObject({
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      scopeRevision: "2",
    });
    expect(await repo.sealUncreatedRequest?.(attempt)).toEqual(sealed);
    Object.assign(v.authorization.recentAuth, {
      authenticatedAt: new Date(v.clock.app.getTime() - 1000),
      expiresAt: new Date(v.clock.app.getTime() + 299000),
    });
    await expect(
      repo.reserveWithdrawal(
        v.snapshot,
        v.authorize,
        v.authorization,
        v.confirmation,
      ),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
  });
  it("recovers only existing records without creating a missing intent", async () => {
    const v = fixture();
    const repo = createWithdrawalReservationRepository(v.db, v.options);
    expect(
      await repo.recoverWithdrawal?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toBeNull();
    expect(v.tables.withdrawal_intent).toHaveLength(0);
    expect(v.tables.financial_operation).toHaveLength(0);
    await repo.reserveWithdrawal(
      v.snapshot,
      v.authorize,
      v.authorization,
      v.confirmation,
    );
    v.options.loadVerifiedPresentationInTransaction.mockClear();
    v.account.isCurrent = false;
    v.destination.isCurrent = false;
    expect(
      await repo.recoverWithdrawal?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toEqual({ snapshot: v.snapshot, intent: v.snapshot.intent });
    expect(
      v.options.loadVerifiedPresentationInTransaction,
    ).not.toHaveBeenCalled();
    expect(
      await repo.sealUncreatedRequest?.({
        ...requestAttempt(v),
        recentAuth: v.authorization.recentAuth,
      }),
    ).toMatchObject({ state: "EXISTING", withdrawal: v.snapshot.intent });
  });
});

it.each(["FAILED", "CANCELLED"])(
  "reads a coherently released native %s without granting another reservation",
  async (state) => {
    const f = fixture();
    const repository = createWithdrawalReservationRepository(f.db, f.options);
    await repository.reserveWithdrawal(
      f.snapshot,
      f.authorize,
      f.authorization,
      f.confirmation,
    );
    Object.assign(f.tables.withdrawal_intent[0], {
      state,
      reservationState: "RELEASED",
      reservedCents: 0,
      providerReference: "transfer-1",
      receiptReference: `asaas-transfer:${"a".repeat(64)}`,
      resolutionObservedAt: now.toISOString(),
    });
    Object.assign(f.tables.financial_operation[0], {
      state,
      attempts: 1,
      providerOperationReference: "transfer-1",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date(+now + 60000).toISOString(),
    });
    expect(
      (await repository.findByRequest("site-1", "request-1"))?.intent.state,
    ).toBe(state);
  },
);

describe("live showcase transactional withdrawal reservation", () => {
  it.each([undefined, "site-other", "site-1"])(
    "reserves only a provider-backed enabled showcase %s",
    async (liveDemoSiteId) => {
      const f = fixture(true);
      const repository = createWithdrawalReservationRepository(f.db, {
        ...f.options,
        liveDemoSiteId,
      });
      const operation = repository.reserveWithdrawal(
        f.snapshot,
        f.authorize,
        f.authorization,
        f.confirmation,
      );
      if (liveDemoSiteId === "site-1") {
        expect((await operation).intent.mode).toBe("live");
        expect(f.site.isDemo).toBe(true);
        expect(await repository.readContext?.(requestAttempt(f))).toMatchObject(
          { mode: "live" },
        );
      } else
        await expect(operation).rejects.toMatchObject({
          code: "PROVIDER_MODE_UNAVAILABLE",
        });
    },
  );
});
