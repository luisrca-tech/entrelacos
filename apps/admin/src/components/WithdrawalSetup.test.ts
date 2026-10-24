// @vitest-environment jsdom
import { createHash, createHmac, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { URL as NodeURL } from "node:url";
import { transferableAbortController } from "node:util";
import type {
  MeResponse,
  SiteAccess,
  WithdrawalRequestContext,
  WithdrawalRequestStatus,
} from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../api/src/app";
import * as authModule from "../../../api/src/auth";
import { createAuth } from "../../../api/src/auth";
import { createFinancialPasswordVerifier } from "../../../api/src/financialPasswordVerifier";
import { createFinancialReauthenticationRateLimit } from "../../../api/src/financialReauthenticationRateLimit";
import { createReceivingNominationComposition } from "../../../api/src/receivingNominationComposition";
import { createReceivingNominationRepository } from "../../../api/src/receivingNominationRepository";
import { evaluateReceivingReadiness } from "../../../api/src/receivingReadiness";
import { loadReceivingContext } from "../../../api/src/receivingRepository";
import { createWithdrawalReservationRepository } from "../../../api/src/withdrawalReservationRepository";
import {
  createWithdrawalReservationService,
  hashWithdrawalConsentSnapshot,
  type WithdrawalConsentSnapshot,
  type WithdrawalFeeScope,
} from "../../../api/src/withdrawalReservations";
import { createWithdrawalStoredPresentationLoader } from "../../../api/src/withdrawalStoredPresentation";
import { ApiError, apiRequest } from "../lib/apiClient";
import { createPanelActorOwner } from "./panelActor";
import {
  createWithdrawalSetupController,
  WithdrawalSetup,
} from "./WithdrawalSetup";
import type { WithdrawalTransport } from "./withdrawalClient";

const apiRequire = createRequire(
  new NodeURL("../../../api/package.json", import.meta.url),
);
type BridgeQuery = (
  statement: string | { text: string; rowMode?: string },
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;
const { drizzle: bridgeDrizzle } = apiRequire("drizzle-orm/node-postgres") as {
  drizzle(client: {
    query: BridgeQuery;
  }): Parameters<typeof createAuth>[0]["db"];
};
const httpBridges: Array<{ cleanup(): Promise<void> }> = [];

const start = Date.parse("2026-10-12T18:00:00.000Z");
const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
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
};
const actor: MeResponse = {
  user: {
    id: "admin-a",
    name: "Admin",
    email: "admin@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2026-10-19T18:00:00.000Z" },
  siteId: "wedding-a",
  memberships: [access],
};
function context(revision = "0"): WithdrawalRequestContext {
  return {
    siteId: access.siteId,
    mode: "sandbox",
    scopeRevision: revision,
    observedAt: new Date(start).toISOString(),
    observationOrder: {
      scopeRevision: revision,
      requestRevision: null,
      recordUpdatedAtMicroseconds: null,
    },
    newRequestAllowed: true,
    reason: null,
    openRequest: null,
    recoverableRequests: [],
    nextCursor: null,
  };
}
function open(
  requestId = "request-a",
): WithdrawalRequestStatus & { state: "OPEN" } {
  return {
    siteId: access.siteId,
    requestId,
    mode: "sandbox",
    state: "OPEN",
    requestRevision: "1",
    scopeRevision: "1",
    observedAt: new Date(start).toISOString(),
    observationOrder: {
      scopeRevision: "1",
      requestRevision: "1",
      recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n),
    },
    preview: {
      siteId: access.siteId,
      requestId,
      mode: "sandbox",
      currency: "BRL",
      amountCents: 10000,
      feeCents: 250,
      netCents: 9750,
      destinationVersion: 3,
      maskedDestination: "Banco **** 1234",
      operatorDisplayName: "Admin",
      policyVersion: "policy-a",
      issuedAt: new Date(start).toISOString(),
      expiresAt: new Date(start + 60000).toISOString(),
    },
  };
}
function unresolved(
  revision = "0",
): WithdrawalRequestStatus & { state: "UNRESOLVED" } {
  return {
    siteId: access.siteId,
    requestId: "request-a",
    mode: "sandbox",
    state: "UNRESOLVED",
    scopeRevision: revision,
    requestRevision: null,
    observedAt: new Date(start).toISOString(),
    observationOrder: {
      scopeRevision: revision,
      requestRevision: null,
      recordUpdatedAtMicroseconds: null,
    },
    command: null,
  };
}
function openContext(value = open()): WithdrawalRequestContext {
  return {
    ...context("1"),
    newRequestAllowed: false,
    reason: "OPEN_REQUEST",
    openRequest: value,
  };
}
function existing(
  value = open(),
  state: "REQUESTED" | "UNKNOWN" = "REQUESTED",
): WithdrawalRequestStatus & { state: "EXISTING" } {
  return {
    ...value,
    state: "EXISTING",
    requestRevision: "2",
    scopeRevision: "2",
    observationOrder: {
      scopeRevision: "2",
      requestRevision: "2",
      recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
    },
    command: {
      requestId: value.requestId,
      amountCents: 10000,
      destinationVersion: 3,
    },
    withdrawal: {
      id: "withdrawal-a",
      siteId: access.siteId,
      amountCents: 10000,
      feeCents: 250,
      netCents: 9750,
      destinationVersion: 3,
      currency: "BRL",
      state,
      createdAt: new Date(start).toISOString(),
      updatedAt: new Date(start).toISOString(),
      mode: "sandbox",
    },
    preview: value.preview,
  };
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing test fixture");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function memory() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    data,
  };
}
async function fixture(
  initial = context(),
  onFinancialChange?: () => void,
  now = () => Date.now(),
) {
  const owner = createPanelActorOwner({
    request: async () => actor,
    now,
  });
  await owner.load();
  const storage = memory();
  let currentContext = initial;
  let currentRequest: WithdrawalRequestStatus =
    initial.openRequest ?? initial.recoverableRequests[0] ?? open();
  const request = vi.fn<WithdrawalTransport>(async (path, options) => {
    if (path === "/v1/me") return actor;
    if (path.endsWith("/context")) return { context: currentContext };
    if (path.endsWith("/preview")) {
      currentRequest = open(
        (required(options).body as { requestId: string }).requestId,
      );
      currentContext = openContext(currentRequest as ReturnType<typeof open>);
      return { request: currentRequest };
    }
    if (options)
      return {
        requestId: currentRequest.requestId,
        withdrawal: existing().withdrawal,
      };
    return { request: currentRequest };
  });
  const changed = vi.fn();
  const scope = {
    siteId: access.siteId,
    access,
    sessionEpoch: owner.getSnapshot().sessionEpoch,
  };
  const ports = {
    owner,
    storage,
    request,
    now,
    newRequestId: vi.fn(() => "request-a"),
  };
  const controller = createWithdrawalSetupController(
    scope,
    changed,
    ports,
    undefined,
    onFinancialChange,
  );
  return {
    controller,
    onFinancialChange,
    scope,
    ports,
    owner,
    storage,
    request,
    changed,
    setContext(value: WithdrawalRequestContext) {
      currentContext = value;
    },
    setRequest(value: WithdrawalRequestStatus) {
      currentRequest = value;
    },
    cleanup() {
      controller.dispose();
      owner.dispose();
    },
  };
}
const mounts: { root: Root; node: HTMLDivElement }[] = [];
let unexpectedFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  unexpectedFetch = vi.fn(async () => {
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", unexpectedFetch);
});
afterEach(async () => {
  for (const bridge of httpBridges.splice(0)) await bridge.cleanup();
  await act(async () => {
    for (const { root, node } of mounts) {
      root.unmount();
      node.remove();
    }
  });
  mounts.length = 0;
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

async function withdrawalHttpBridge(
  options: {
    receivingEvidenceProvenance?: "PROVIDER" | "SIMULATION";
    sqlNow?: () => Date;
  } = {},
) {
  vi.stubGlobal("crypto", webcrypto);
  // Node Request rejects jsdom's signal brand; use the actual Node constructors.
  const nativeAbort = transferableAbortController();
  vi.stubGlobal("AbortController", nativeAbort.constructor);
  vi.stubGlobal("AbortSignal", nativeAbort.signal.constructor);
  const origin = "https://admin.example.test";
  const secret = "fictional-withdrawal-native-auth-secret-32";
  const token = "fictional-withdrawal-session-token";
  const clock = () => new Date(Date.now());
  const storedSession = {
    id: "session-a",
    userId: "admin-a",
    token,
    createdAt: new Date(start - 60000),
    updatedAt: clock(),
    lastActiveAt: clock(),
    expiresAt: new Date(start + 3600000),
    ipAddress: null,
    userAgent: null,
  };
  const storedUser = {
    id: "admin-a",
    name: "Admin",
    email: "admin@example.test",
    emailVerified: true,
    image: null,
    role: "SITE_ADMIN",
    state: "ACTIVE",
    createdAt: new Date(start - 3600000),
    updatedAt: clock(),
  };
  const site = { id: access.siteId, siteId: access.siteId, isDemo: true };
  const account = {
    id: "account-bridge-a",
    siteId: access.siteId,
    environment: "sandbox",
    provider: "ASAAS",
    operatorUserId: storedUser.id,
    operatorReference: "fictional-operator",
    accountReference: "fictional-account",
    recipientReference: "fictional-wallet",
    providerAccountState: "APPROVED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    isCurrent: true,
    observedAt: clock(),
  };
  const destination = {
    id: "destination-bridge-a",
    siteId: access.siteId,
    accountId: account.id,
    environment: "sandbox",
    version: 3,
    bankReference: "fictional-bank",
    bankState: "VERIFIED",
    maskedDescriptor: "Banco **** 1234",
    isCurrent: true,
  };
  const evidence = {
    id: "evidence-bridge-a",
    siteId: access.siteId,
    accountId: account.id,
    environment: "sandbox",
    destinationVersion: 3,
    operatorReference: account.operatorReference,
    accountReference: account.accountReference,
    recipientReference: account.recipientReference,
    bankReference: destination.bankReference,
    verificationStatus: "VERIFIED",
    verificationReference: "fictional-verification",
    // The happy path represents provider-origin bank facts; checkout simulations are exercised separately.
    provenance: options.receivingEvidenceProvenance ?? "PROVIDER",
    providerAccountState: "APPROVED",
    bankState: "VERIFIED",
    receivingCapability: true,
    withdrawalCapability: true,
    commercialEnabled: true,
    observedAt: clock(),
    bankObservedAt: clock(),
    createdAt: clock(),
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    receiving_account: [account],
    receiving_destination: [destination],
    receiving_verification_evidence: [evidence],
    withdrawal_request: [],
    withdrawal_intent: [],
    financial_operation: [],
    financial_ledger_entry: [],
    verification: [],
  };
  const state = {
    currentSession: true,
    revoked: false,
    origin,
    cookie: "",
    activity: 0,
    commitLost: false,
    membershipRole: "SITE_ADMIN",
    exactNativeOverride: null as Record<string, unknown> | null,
  };
  const gates: Array<{
    pattern: RegExp;
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
    used: boolean;
  }> = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const unknownQueries: string[] = [];
  let before: typeof tables | null = null;
  let credential = "";
  const camel = (value: string) =>
    value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const projected = (
    sql: string,
    sources: Record<string, Record<string, unknown>>,
  ) =>
    Object.fromEntries(
      sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(",")
        .map((part) => {
          const field = part
            .trim()
            .match(/^(\w+)\.([a-z_]+)(::text)?(?: AS "([^"]+)")?$/);
          if (!field)
            throw new Error("Unsupported withdrawal stored projection");
          const value = sources[field[1]]?.[camel(field[2])];
          return [
            field[4] ?? camel(field[2]),
            field[3] ? String(value) : value,
          ];
        }),
    );
  const query: BridgeQuery = async (statement, params = []) => {
    const sql = typeof statement === "string" ? statement : statement.text;
    queries.push({ sql, params });
    const gate = gates.find((value) => !value.used && value.pattern.test(sql));
    if (gate) {
      gate.used = true;
      gate.entered.resolve();
      await gate.release.promise;
    }
    if (/^begin/i.test(sql)) {
      before = structuredClone(tables);
      return { rows: [] };
    }
    if (/^commit/i.test(sql)) {
      before = null;
      if (state.commitLost && tables.withdrawal_intent.length) {
        state.commitLost = false;
        throw new Error("Synthetic committed acknowledgment lost");
      }
      return { rows: [] };
    }
    if (/^rollback/i.test(sql)) {
      if (before) Object.assign(tables, before);
      before = null;
      return { rows: [] };
    }
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/SELECT clock_timestamp\(\)/i.test(sql))
      return { rows: [{ currentTime: (options.sqlNow ?? clock)() }] };
    if (/^select .*from "session" inner join "user"/i.test(sql))
      return {
        rows:
          state.currentSession && params[0] === storedSession.id
            ? [
                [
                  storedSession.id,
                  storedSession.userId,
                  storedSession.createdAt.toISOString(),
                  storedSession.expiresAt.toISOString(),
                  storedSession.lastActiveAt.toISOString(),
                  storedUser.name,
                  storedUser.email,
                  storedUser.role,
                  storedUser.state,
                ],
              ]
            : [],
      };
    if (/^update "session"/i.test(sql)) {
      expect(params[2]).toBe(storedSession.id);
      storedSession.lastActiveAt = new Date(String(params[0]));
      state.activity++;
      return { rows: [] };
    }
    if (/INNER JOIN "user" u ON u.id = a.user_id/.test(sql))
      return {
        rows:
          params[0] === storedUser.id && storedUser.state === "ACTIVE"
            ? [{ password: credential }]
            : [],
      };
    if (/FROM "verification" v/.test(sql))
      return {
        rows: tables.verification.filter((row) => row.id === params[0]),
      };
    if (/INSERT INTO "verification"/.test(sql)) {
      const row = {
        id: params[0],
        identifier: params[1],
        value: params[2],
        expiresAt: params[3],
      };
      const index = tables.verification.findIndex(
        (value) => value.id === row.id,
      );
      if (index < 0) tables.verification.push(row);
      else tables.verification[index] = row;
      return { rows: [{ id: row.id }] };
    }
    if (/AS "scopeUnresolvedCount"/.test(sql))
      return {
        rows: [
          {
            scopeUnresolvedCount: String(
              tables.withdrawal_intent.filter(
                (row) =>
                  row.siteId === params[0] &&
                  row.environment === params[1] &&
                  row.operatorUserId === params[2] &&
                  row.state === "UNKNOWN",
              ).length +
                tables.financial_operation.filter(
                  (row) =>
                    row.siteId === params[0] &&
                    row.environment === params[1] &&
                    row.state === "UNKNOWN" &&
                    tables.receiving_account.some(
                      (a) =>
                        a.id === row.accountId &&
                        a.operatorUserId === params[2],
                    ),
                ).length,
            ),
          },
        ],
      };
    if (/AS "heldCents"/.test(sql))
      return {
        rows: [
          {
            heldCents: String(
              tables.withdrawal_intent
                .filter(
                  (row) =>
                    row.siteId === account.siteId &&
                    row.accountId === account.id &&
                    row.environment === account.environment &&
                    row.reservationState === "HELD",
                )
                .reduce(
                  (sum, row) => sum + BigInt(row.reservedCents as number),
                  0n,
                ),
            ),
            unresolvedFinancialEventCount: String(
              tables.financial_operation.filter(
                (row) => row.state === "UNKNOWN",
              ).length,
            ),
            balanceEffectsAfterObservationCount: String(
              tables.financial_ledger_entry.filter(
                (row) =>
                  row.direction === "DEBIT" &&
                  new Date(String(row.createdAt)).getTime() >=
                    new Date(String(params.at(-1))).getTime(),
              ).length,
            ),
          },
        ],
      };
    if (/UPDATE "withdrawal_request" r/.test(sql)) {
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
          new Date(String(r.expiresAt)).getTime() > Date.now(),
      );
      if (!row) return { rows: [] };
      Object.assign(row, {
        state: "COMMITTED",
        requestRevision: 2n,
        withdrawalIntentId: params[0],
        updatedAt: clock().toISOString(),
      });
      return { rows: [{ id: row.id }] };
    }
    if (/FROM "withdrawal_request" r/.test(sql)) {
      if (/SUM\(r.request_revision\)/.test(sql))
        return {
          rows: [
            {
              scopeRevision: String(
                tables.withdrawal_request
                  .filter(
                    (row) =>
                      row.siteId === params[0] && row.environment === params[1],
                  )
                  .reduce(
                    (sum, row) => sum + BigInt(row.requestRevision as string),
                    0n,
                  ),
              ),
            },
          ],
        };
      return {
        rows: tables.withdrawal_request
          .filter(
            (row) =>
              row.siteId === params[0] &&
              (/r\.request_id=/.test(sql)
                ? row.requestId === params[1]
                : row.environment === params[1] &&
                  row.operatorUserId === params[2]),
          )
          .map((r) => projected(sql, { r })),
      };
    }
    if (/FROM "withdrawal_intent" w/.test(sql)) {
      const override =
        /w\.request_id=/.test(sql) &&
        state.exactNativeOverride?.requestId === params[1]
          ? state.exactNativeOverride
          : null;
      if (override) state.exactNativeOverride = null;
      return {
        rows: (override ? [override] : tables.withdrawal_intent)
          .filter(
            (row) =>
              row.siteId === params[0] &&
              (/w\.request_id=/.test(sql)
                ? row.requestId === params[1]
                : row.environment === params[1] &&
                  row.operatorUserId === params[2]),
          )
          .flatMap((w) => {
            const a = tables.receiving_account.find(
              (row) =>
                row.id === w.accountId &&
                row.siteId === w.siteId &&
                row.environment === w.environment,
            );
            return a ? [projected(sql, { w, a })] : [];
          }),
      };
    }
    if (/FROM "financial_operation" op/.test(sql))
      return {
        rows: tables.financial_operation
          .filter(
            (row) =>
              row.siteId === params[0] &&
              (/op\.withdrawal_intent_id=/.test(sql)
                ? row.withdrawalIntentId === params[1]
                : /op\.request_id=/.test(sql)
                  ? row.requestId === params[1] && row.kind === "WITHDRAWAL"
                  : row.environment === params[1] &&
                    row.kind === "WITHDRAWAL" &&
                    tables.receiving_account.some(
                      (a) =>
                        a.id === row.accountId &&
                        a.operatorUserId === params[2],
                    )),
          )
          .map((op) => projected(sql, { op })),
      };
    if (
      /FROM "user" u/.test(sql) &&
      /INNER JOIN site s|INNER JOIN site_membership/.test(sql)
    ) {
      const selected =
        params.length === 1
          ? params[0] === storedUser.id
          : params[0] === access.siteId &&
            params[1] === storedUser.id &&
            params[2] === storedUser.role;
      return {
        rows:
          selected && !state.revoked && storedUser.state === "ACTIVE"
            ? [
                {
                  user_id: storedUser.id,
                  account_role: storedUser.role,
                  account_state: storedUser.state,
                  site_id: access.siteId,
                  membership_id: access.membershipId,
                  membership_user_id: storedUser.id,
                  membership_role: state.membershipRole,
                  revoked_at: null,
                },
              ]
            : [],
      };
    }
    if (
      typeof statement !== "string" &&
      statement.rowMode === "array" &&
      /^select /i.test(sql)
    ) {
      const name = sql.match(/ from "([a-z_]+)"/i)?.[1];
      const rows =
        name === "site"
          ? params[0] === site.id
            ? [site]
            : []
          : name && tables[name]
            ? tables[name].filter(
                (row) =>
                  row.siteId === params[0] &&
                  (name === "receiving_account"
                    ? row.environment === params[1] &&
                      row.isCurrent === params[2]
                    : row.accountId === params[1] &&
                      row.environment === params[2] &&
                      (name === "receiving_destination"
                        ? row.isCurrent === params[3]
                        : row.destinationVersion === params[3])),
              )
            : null;
      if (rows) {
        const columns = [
          ...sql
            .slice(0, sql.toLowerCase().indexOf(" from "))
            .matchAll(/"([a-z_]+)"/g),
        ].map((match) => camel(match[1]));
        return {
          rows: rows
            .slice(0, name === "receiving_verification_evidence" ? 2 : 1)
            .map((row) =>
              columns.map((column) => {
                const value = (row as Record<string, unknown>)[column];
                return value instanceof Date ? value.toISOString() : value;
              }),
            ),
        };
      }
    }
    if (/JOIN LATERAL/.test(sql) && /FROM "receiving_account" a/.test(sql)) {
      const a = tables.receiving_account.find(
        (row) =>
          row.siteId === params[0] &&
          row.id === params[1] &&
          row.environment === params[2] &&
          row.accountReference === params[3] &&
          row.isCurrent,
      );
      const d = tables.receiving_destination.find(
        (row) =>
          a &&
          row.siteId === a.siteId &&
          row.accountId === a.id &&
          row.environment === a.environment &&
          row.version === params[4] &&
          row.bankReference === params[5] &&
          row.isCurrent,
      );
      const u = a?.operatorUserId === storedUser.id ? storedUser : null;
      return {
        rows:
          a && d && u
            ? tables.receiving_verification_evidence
                .filter(
                  (e) =>
                    e.siteId === a.siteId &&
                    e.accountId === a.id &&
                    e.environment === a.environment &&
                    e.destinationVersion === d.version,
                )
                .slice(0, 2)
                .map((e) => projected(sql, { st: site, a, d, u, e }))
            : [],
      };
    }
    if (/FROM "site" st/.test(sql))
      return { rows: params[0] === site.id ? [site] : [] };
    if (/FROM "user" u/.test(sql))
      return {
        rows:
          params[0] === storedUser.id && storedUser.state === "ACTIVE"
            ? [
                {
                  userId: storedUser.id,
                  role: storedUser.role,
                  state: storedUser.state,
                  operatorDisplayName: storedUser.name,
                  operatorProfileUpdatedAt: storedUser.updatedAt,
                },
              ]
            : [],
      };
    if (/FROM "session" se/.test(sql))
      return {
        rows:
          state.currentSession &&
          params[0] === storedSession.id &&
          params[1] === storedUser.id
            ? [
                {
                  userId: storedUser.id,
                  sessionId: storedSession.id,
                  sessionExpiresAt: storedSession.expiresAt,
                  lastActiveAt: storedSession.lastActiveAt,
                  sessionCreatedAt: storedSession.createdAt,
                },
              ]
            : [],
      };
    if (/FROM "site_membership" m/.test(sql))
      return {
        rows:
          params[0] === site.id &&
          params[1] === storedUser.id &&
          !state.revoked &&
          state.membershipRole === "SITE_ADMIN"
            ? [
                {
                  id: access.membershipId,
                  siteId: site.id,
                  userId: storedUser.id,
                  role: state.membershipRole,
                  revokedAt: null,
                },
              ]
            : [],
      };
    if (/FROM "receiving_account" a/.test(sql))
      return {
        rows: tables.receiving_account.filter((row) =>
          /a\.id=/.test(sql)
            ? row.id === params[0] &&
              row.siteId === params[1] &&
              row.environment === params[2]
            : row.siteId === params[0] &&
              row.environment === params[1] &&
              row.isCurrent,
        ),
      };
    if (/FROM "receiving_destination" d/.test(sql))
      return {
        rows: tables.receiving_destination.filter(
          (row) =>
            row.siteId === params[0] &&
            row.accountId === params[1] &&
            row.environment === params[2] &&
            row.isCurrent &&
            (params.length < 4 || row.version === params[3]),
        ),
      };
    if (/FROM "receiving_verification_evidence" ev/.test(sql))
      return {
        rows: tables.receiving_verification_evidence
          .filter(
            (row) =>
              row.siteId === params[0] &&
              row.accountId === params[1] &&
              row.environment === params[2] &&
              row.destinationVersion === params[3],
          )
          .slice(0, 2),
      };
    const insert = sql.match(
      /^insert into "([a-z_]+)" \((.*?)\) values \((.*?)\)/i,
    );
    if (insert && tables[insert[1]]) {
      const columns = [...insert[2].matchAll(/"?([a-z_]+)"?/g)].map((value) =>
        camel(value[1]),
      );
      const values = insert[3].split(",").map((part) => {
        const p = part.trim().match(/^\$(\d+)(?:::\w+)?$/);
        return p
          ? params[Number(p[1]) - 1]
          : /^'(.+)'$/.test(part.trim())
            ? part.trim().slice(1, -1)
            : /^\d+$/.test(part.trim())
              ? BigInt(part.trim())
              : null;
      });
      const row = Object.fromEntries(
        columns.map((column, index) => [column, values[index]]),
      );
      for (const field of ["requestSnapshot", "previewSnapshot"])
        if (typeof row[field] === "string") row[field] = JSON.parse(row[field]);
      tables[insert[1]].push(row);
      return {
        rows:
          typeof statement !== "string" && statement.rowMode === "array"
            ? [[row.id]]
            : [{ id: row.id }],
      };
    }
    unknownQueries.push(sql);
    throw new Error("Unsupported withdrawal bridge SQL");
  };
  const db = bridgeDrizzle({ query });
  const authentication = {
    db,
    secret,
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  };
  const auth = createAuth(authentication);
  const native = await auth.$context;
  credential = await native.password.hash("fictional-password");
  const lookup = async (selected: string) =>
    selected === token
      ? ({
          session: structuredClone(storedSession),
          user: structuredClone(storedUser),
        } as never)
      : null;
  vi.spyOn(native.internalAdapter, "findSession").mockImplementation(lookup);
  const builder = authModule.createSessionReadAuth;
  let readAuth!: ReturnType<typeof createAuth>;
  const capture = vi
    .spyOn(authModule, "createSessionReadAuth")
    .mockImplementation((options) => {
      readAuth = builder(options);
      return readAuth;
    });
  const ports = createReceivingNominationComposition({
    standardAuth: auth,
    authentication,
    configuration: {
      mode: "sandbox",
      applicationEnvironment: "test",
      policyVersion: "bridge-policy-a",
      requestIdentityVersion: "nr1",
    },
    nomination: {
      repository: createReceivingNominationRepository(db, {
        mode: "sandbox",
        applicationEnvironment: "test",
        maxAuthAgeMs: 300000,
        now: clock,
      }),
      loadSite: async (siteId) =>
        siteId === site.id ? { siteId, isDemo: site.isDemo } : null,
      generateId: (kind) => `${kind}-bridge-a`,
    },
    reauthentication: {
      keyId: "bridge-proof-a",
      key: new Uint8Array(32).fill(7),
      maxAgeMs: 300000,
      password: createFinancialPasswordVerifier(db),
      rateLimit: createFinancialReauthenticationRateLimit(db, {
        maxAttempts: 3,
        windowMs: 60000,
      }),
    },
    now: clock,
  });
  capture.mockRestore();
  const readNative = await readAuth.$context;
  vi.spyOn(readNative.internalAdapter, "findSession").mockImplementation(
    lookup,
  );
  const readDelete = vi.spyOn(readNative.internalAdapter, "deleteSession");
  state.cookie = `${native.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
  const receiving = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    freshnessMs: 60000,
    now: ports.now,
  };
  const loadPresentation = createWithdrawalStoredPresentationLoader(receiving);
  const repository = createWithdrawalReservationRepository(db, {
    ...receiving,
    maxAuthAgeMs: 300000,
    loadVerifiedPresentationInTransaction: loadPresentation,
  });
  const fee = vi.fn<(scope: WithdrawalFeeScope) => Promise<void>>(
    async () => {},
  );
  const withdrawalReservation = createWithdrawalReservationService({
    ...receiving,
    maxAuthAgeMs: 300000,
    generateId: (kind) => `${kind}-bridge-a`,
    repository,
    loadContext: async (siteId) => {
      const context = await loadReceivingContext(db, siteId, receiving);
      if (!context) return null;
      const binding = context.providerBinding;
      const a = tables.receiving_account.find(
        (row) =>
          row.siteId === siteId &&
          row.environment === context.mode &&
          row.operatorReference === binding?.operatorReference &&
          row.accountReference === binding?.accountReference,
      );
      return {
        siteId,
        isDemo: context.isDemo,
        mode: "sandbox",
        verification: context.evidence?.verification ?? "unverified",
        accountId: a ? String(a.id) : null,
        bankReference: binding?.bankReference ?? null,
        readiness: evaluateReceivingReadiness({
          ...context,
          siteId,
          now: ports.now(),
        }),
        recipientBinding:
          a &&
          binding?.accountReference &&
          binding.recipientReference &&
          binding.destinationVersion
            ? {
                siteId,
                operatorUserId: String(a.operatorUserId),
                accountReference: binding.accountReference,
                recipientReference: binding.recipientReference,
                environment: "sandbox",
                destinationVersion: binding.destinationVersion,
              }
            : null,
      };
    },
    loadVerifiedPresentation: (scope) =>
      db.transaction((tx) => loadPresentation(tx, scope), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }),
    feeQuotes: {
      quoteWithdrawal: async (scope) => {
        await fee(scope);
        return {
          ...scope,
          feeCents: 250,
          policyVersion: "synthetic-fee-a",
          provenance: "simulation",
          verification: "verified",
          observedAt: clock(),
          expiresAt: new Date(Date.now() + 60000),
        };
      },
    },
    // Synthetic provider observation; the existing balance contract has no simulation variant.
    balance: {
      getBalance: async (scope) => ({
        source: "provider",
        provider: "ASAAS",
        siteId: scope.siteId,
        accountBindingId: scope.accountId,
        accountReference: scope.accountReference,
        environment: scope.environment,
        currency: "BRL",
        observedAt: clock(),
        balanceCents: 10000000,
      }),
    },
  });
  const app = createApp(
    {
      auth,
      db,
      adminOrigin: origin,
      receiving,
      ...ports,
      withdrawalReservation,
    },
    { sink: () => {} },
  );
  const pending = new Set<Promise<unknown>>();
  const responses: Array<{
    path: string;
    method: string;
    status: number;
    cookie: string | null;
  }> = [];
  const nativeRequests: Request[] = [];
  const request = vi.fn<WithdrawalTransport>(async (path, options) => {
    const work = apiRequest(path, options, (async (input, init) => {
      expect(String(input).startsWith("/api/v1/")).toBe(true);
      const nativeRequest = new Request(
        `https://api.example.test${String(input).slice(4)}`,
        {
          ...init,
          signal: options?.signal,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            Origin: state.origin,
            Cookie: state.cookie,
          },
        },
      );
      nativeRequests.push(nativeRequest);
      const response = await app.request(nativeRequest);
      responses.push({
        path,
        method: init?.method ?? "GET",
        status: response.status,
        cookie: response.headers.get("set-cookie"),
      });
      return response;
    }) as typeof fetch);
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  const owner = createPanelActorOwner({
    request: () => request("/v1/me"),
    now: () => Date.now(),
  });
  await owner.load();
  expect(owner.getSnapshot().actor?.memberships?.[0]).toEqual(access);
  const storage = memory();
  const scope = {
    siteId: site.id,
    access: owner.getSnapshot().actor?.memberships?.[0] ?? null,
    sessionEpoch: owner.getSnapshot().sessionEpoch,
  };
  const fixturePorts = {
    owner,
    request,
    storage,
    now: () => Date.now(),
    newRequestId: () => "request-bridge-a",
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounts.push({ root, node });
  const settle = async () => {
    for (;;) {
      const issued = request.mock.calls.length;
      await act(async () => {
        await Promise.allSettled([...pending]);
      });
      if (!pending.size && request.mock.calls.length === issued) break;
    }
  };
  httpBridges.push({
    cleanup: async () => {
      await act(async () => root.unmount());
      const index = mounts.findIndex((entry) => entry.root === root);
      if (index >= 0) mounts.splice(index, 1);
      node.remove();
      owner.dispose();
      for (const gate of gates) gate.release.resolve();
      await settle();
      expect(pending.size).toBe(0);
      expect(unknownQueries).toEqual([]);
      expect(readDelete).not.toHaveBeenCalled();
    },
  });
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(WithdrawalSetup, { ...scope, ports: fixturePorts }),
      ),
    ),
  );
  await settle();
  return {
    request,
    owner,
    state,
    tables,
    queries,
    responses,
    node,
    root,
    scope,
    ports: fixturePorts,
    settle,
    account,
    destination,
    evidence,
    storage,
    pending,
    fee,
    nativeRequests,
    block(pattern: RegExp) {
      const gate = {
        pattern,
        entered: deferred<void>(),
        release: deferred<void>(),
        used: false,
      };
      gates.push(gate);
      return gate;
    },
  };
}

describe("withdrawal setup mounted consumer through actual private HTTP", () => {
  it("waits once for a real SQL context ahead of the browser without repeating its read", async () => {
    let sqlAheadMs = 0;
    const f = await withdrawalHttpBridge({
      sqlNow: () => new Date(Date.now() + sqlAheadMs),
    });
    sqlAheadMs = 500;
    await act(async () =>
      required(
        [...f.node.querySelectorAll("button")].find(
          (button) => button.textContent === "Consultar situação",
        ),
      ).click(),
    );
    await f.settle();
    const calls = f.request.mock.calls.length;
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(f.node.querySelector("#withdrawal-amount")).not.toBeNull();
    expect(f.request).toHaveBeenCalledTimes(calls);
    expect(f.tables.withdrawal_request).toHaveLength(0);
    expect(f.tables.withdrawal_intent).toHaveLength(0);
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
  });
  it("installs one successful preview after the browser reaches the unchanged SQL observation instant", async () => {
    let sqlAheadMs = 0;
    const success = vi.spyOn(toast, "success");
    const f = await withdrawalHttpBridge({
      sqlNow: () => new Date(Date.now() + sqlAheadMs),
    });
    const insert = f.block(/^INSERT INTO "withdrawal_request"/i);
    const work = httpWithdrawalPreview(f);
    await insert.entered.promise;
    sqlAheadMs = 250;
    insert.release.resolve();
    await work;
    expect(
      f.responses.filter((value) => value.path.endsWith("/preview")),
    ).toEqual([expect.objectContaining({ method: "POST", status: 200 })]);
    expect(f.tables.withdrawal_request).toHaveLength(1);
    expect(f.tables.withdrawal_request[0]).toMatchObject({
      requestId: "request-bridge-a",
      state: "OPEN",
    });
    const calls = f.request.mock.calls.length;
    expect(success).not.toHaveBeenCalled();
    expect(f.node.textContent).not.toContain("Banco **** 1234");
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(success).not.toHaveBeenCalled();
    expect(f.node.textContent).not.toContain("Banco **** 1234");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(f.node.textContent).toContain("Banco **** 1234");
    expect(f.node.textContent).not.toContain("Resultado em verificação");
    expect(success).toHaveBeenCalledWith(
      "Prévia pronta. Confira o destino, os valores e a validade antes de confirmar.",
    );
    expect(f.request).toHaveBeenCalledTimes(calls);
    expect(f.tables.withdrawal_intent).toHaveLength(0);
    expect(f.tables.financial_operation).toHaveLength(0);
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
  });
  it("keeps demo SIMULATION receiving evidence unable to expose a withdrawal form or create preview and reservation rows", async () => {
    const f = await withdrawalHttpBridge({
      receivingEvidenceProvenance: "SIMULATION",
    });
    const context = await f.request("/v1/sites/wedding-a/withdrawals/context");
    expect(context).toMatchObject({
      context: { newRequestAllowed: false, reason: "DESTINATION_UNAVAILABLE" },
    });
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await expect(
      f.request("/v1/sites/wedding-a/withdrawals/preview", {
        method: "POST",
        body: {
          requestId: "request-simulation-denied",
          amountCents: 10000,
          scopeRevision: "0",
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "DESTINATION_UNVERIFIED" });
    expect(f.tables.withdrawal_request).toHaveLength(0);
    expect(f.tables.withdrawal_intent).toHaveLength(0);
    expect(f.tables.financial_operation).toHaveLength(0);
    expect(f.tables.financial_ledger_entry).toHaveLength(0);
    expect(f.evidence.provenance).toBe("SIMULATION");
  });
  it("loads actual row-backed readiness and read-only withdrawal context through native cookie auth", async () => {
    const f = await withdrawalHttpBridge();
    expect(f.responses).toContainEqual(
      expect.objectContaining({
        path: "/v1/sites/wedding-a/withdrawals/context",
        method: "GET",
        status: 200,
        cookie: null,
      }),
    );
    expect(f.state.activity).toBe(1);
    expect(f.node.querySelector("#withdrawal-amount")).not.toBeNull();
    expect(f.tables.withdrawal_request).toHaveLength(0);
  });
  it.each([false, true])(
    "preserves one actual HELD reservation after mounted consent, lost synthetic acknowledgment=%s",
    async (lost) => {
      const f = await withdrawalHttpBridge();
      await httpWithdrawalPreview(f);
      expect(f.tables.withdrawal_request).toHaveLength(1);
      expect(f.tables.withdrawal_request[0]).toMatchObject({
        requestId: "request-bridge-a",
        state: "OPEN",
      });
      expect(f.node.textContent).toContain("Banco **** 1234");
      await httpWithdrawalPassword(f);
      f.state.commitLost = lost;
      const confirm = required(
        [...f.node.querySelectorAll("button")].find(
          (button) => button.textContent === "Confirmar solicitação de saque",
        ),
      );
      expect(confirm.disabled).toBe(true);
      await act(async () =>
        required(
          f.node.querySelector<HTMLInputElement>('input[type="checkbox"]'),
        ).click(),
      );
      await act(async () => {
        confirm.click();
        confirm.click();
      });
      await f.settle();
      expect(
        f.responses
          .filter(
            (value) =>
              value.path.endsWith("/withdrawals") && value.method === "POST",
          )
          .at(-1),
      ).toMatchObject({ status: lost ? 503 : 200 });
      expect(f.tables.withdrawal_intent).toHaveLength(1);
      expect(f.tables.financial_operation).toHaveLength(1);
      expect(f.tables.withdrawal_intent[0]).toMatchObject({
        requestId: "request-bridge-a",
        state: "REQUESTED",
        reservationState: "HELD",
        reservedCents: 10000,
        amountCents: 10000,
        feeCents: 250,
        netCents: 9750,
        accountId: f.account.id,
        destinationVersion: 3,
        providerReference: null,
      });
      expect(f.tables.withdrawal_request[0]).toMatchObject({
        state: "COMMITTED",
        withdrawalIntentId: f.tables.withdrawal_intent[0].id,
      });
      expect(f.tables.financial_ledger_entry).toHaveLength(0);
      expect(
        f.request.mock.calls.filter(
          ([path, options]) =>
            path.endsWith("/withdrawals") && options?.method === "POST",
        ),
      ).toHaveLength(1);
      const originals = structuredClone({
        request: f.tables.withdrawal_request,
        intent: f.tables.withdrawal_intent,
        operation: f.tables.financial_operation,
      });
      const selected = await f.request(
        "/v1/sites/wedding-a/withdrawals/requests/request-bridge-a",
      );
      expect(selected).toMatchObject({
        request: {
          state: "EXISTING",
          requestId: "request-bridge-a",
          withdrawal: { state: "REQUESTED" },
        },
      });
      expect({
        request: f.tables.withdrawal_request,
        intent: f.tables.withdrawal_intent,
        operation: f.tables.financial_operation,
      }).toEqual(originals);
      expect(f.responses.at(-1)?.cookie).toBeNull();
      expect(f.node.innerHTML).not.toContain("fr1.");
      expect(JSON.stringify([...f.storage.data.values()])).not.toContain(
        "fr1.",
      );
      expect(f.node.textContent).not.toMatch(
        /crédito confirmado|beneficiário verificado/i,
      );
    },
  );
  it.each(["bank", "commercial", "stale", "foreignBinding"] as const)(
    "denies actual stored readiness after %s changes before preview",
    async (kind) => {
      const f = await withdrawalHttpBridge();
      if (kind === "bank") f.destination.bankState = "UNVERIFIED";
      if (kind === "commercial") f.account.commercialEnabled = false;
      if (kind === "stale") f.evidence.bankObservedAt = new Date(start - 60001);
      if (kind === "foreignBinding")
        f.evidence.accountReference = "foreign-account";
      await httpWithdrawalPreview(f);
      expect(f.tables.withdrawal_request).toHaveLength(0);
      expect(f.tables.withdrawal_intent).toHaveLength(0);
      expect(document.querySelector('input[type="password"]')).toBeNull();
      expect(f.fee).not.toHaveBeenCalled();
    },
  );
  it("retains actual UNKNOWN obligations and recovers only the original request without another hold", async () => {
    const f = await httpWithdrawalReserved();
    const originals = structuredClone({
      intents: f.tables.withdrawal_intent,
      operations: f.tables.financial_operation,
    });
    vi.setSystemTime(start + 1);
    f.tables.withdrawal_intent[0].state = "UNKNOWN";
    f.tables.withdrawal_intent[0].updatedAt = new Date(start + 1).toISOString();
    await httpWithdrawalClick(f, "Consultar situação");
    expect(f.node.textContent).toContain("Resultado em verificação");
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    const context = await f.request("/v1/sites/wedding-a/withdrawals/context");
    expect(context).toMatchObject({
      context: {
        newRequestAllowed: false,
        reason: "UNRESOLVED_OPERATION",
        recoverableRequests: [
          { requestId: "request-bridge-a", withdrawal: { state: "UNKNOWN" } },
        ],
      },
    });
    const missing = await f.request(
      "/v1/sites/wedding-a/withdrawals/requests/missing-original",
    );
    expect(missing).toMatchObject({
      request: { state: "UNRESOLVED", command: null },
    });
    const proof = (await f.request(
      "/v1/sites/wedding-a/financial-reauthentication",
      {
        method: "POST",
        body: { action: "REQUEST_WITHDRAWAL", password: "fictional-password" },
      },
    )) as { reauthenticationToken: string };
    const recover = await f.request("/v1/sites/wedding-a/withdrawals", {
      method: "POST",
      body: {
        action: "RECOVER_EXISTING",
        requestId: "request-bridge-a",
        reauthenticationToken: proof.reauthenticationToken,
      },
    });
    expect(recover).toMatchObject({
      withdrawal: {
        id: originals.intents[0].id,
        state: "UNKNOWN",
        amountCents: 10000,
        destinationVersion: 3,
      },
    });
    expect(f.tables.withdrawal_intent).toHaveLength(1);
    expect(f.tables.financial_operation).toEqual(originals.operations);
    expect(f.tables.withdrawal_intent[0].reservationState).toBe("HELD");
    const marker = [...f.storage.data.values()];
    f.tables.financial_operation.length = 0;
    await httpWithdrawalClick(f, "Consultar situação");
    expect([...f.storage.data.values()]).toEqual(marker);
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    expect(f.responses.at(-1)?.status).toBe(503);
  });
  it("reads the real 100-row cursor page, separate OPEN obligation and deliberately selected exact original ID", async () => {
    const f = await httpWithdrawalHistory();
    const writes = f.queries.filter(
      (value) =>
        /^(?:update|insert)/i.test(value.sql) &&
        !/^update "session"/i.test(value.sql),
    ).length;
    const activity = f.state.activity;
    await httpWithdrawalClick(f, "Consultar situação");
    await expect(
      f.request("/v1/sites/wedding-a/withdrawals/context"),
    ).resolves.toMatchObject({
      context: {
        openRequest: { requestId: "zz-open-original" },
        newRequestAllowed: false,
        reason: "OPEN_REQUEST",
      },
    });
    const more = required(
      [...f.node.querySelectorAll("button")].find(
        (button) => button.textContent === "Carregar mais solicitações",
      ),
    );
    expect(more.disabled).toBe(false);
    expect(f.responses.at(-1)?.status).toBe(200);
    expect(
      f.request.mock.calls.some(([path]) => path.includes("cursor=")),
    ).toBe(false);
    await act(async () => {
      more.click();
      more.click();
    });
    await f.settle();
    expect(
      f.node.querySelector('[role="alert"]')?.textContent ?? null,
    ).toBeNull();
    expect(f.owner.getSnapshot().status).toBe("verified");
    expect(
      f.request.mock.calls
        .filter(([path]) => path.includes("cursor="))
        .map(([path]) => path),
    ).toEqual([
      "/v1/sites/wedding-a/withdrawals/context?cursor=wc1%3Ahistory-099",
    ]);
    await httpWithdrawalSelect(f, "history-099");
    expect(
      f.request.mock.calls.some(([path]) =>
        path.endsWith("/requests/history-099"),
      ),
    ).toBe(true);
    expect(
      f.node.querySelector('[data-request-id="history-099"]'),
    ).not.toBeNull();
    expect(f.node.textContent).toContain("Retomar solicitação em andamento");
    expect(
      f.queries.filter(
        (value) =>
          /^(?:update|insert)/i.test(value.sql) &&
          !/^update "session"/i.test(value.sql),
      ),
    ).toHaveLength(writes);
    expect(f.state.activity).toBe(activity + 1);
    expect(
      f.responses
        .filter((value) => value.method === "GET")
        .every((value) => value.cookie === null),
    ).toBe(true);
    expect(f.tables.withdrawal_intent).toHaveLength(101);
    expect(
      f.tables.withdrawal_request.filter((row) => row.state === "OPEN"),
    ).toHaveLength(1);
  });
  it("keeps the actual driver request pending after abort and keyed owner replacement until it settles", async () => {
    const f = await httpWithdrawalHistory();
    await httpWithdrawalClick(f, "Consultar situação");
    const gate = f.block(/FROM "withdrawal_request" r/);
    const refresh = required(
      [...f.node.querySelectorAll("button")].find(
        (button) => button.textContent === "Carregar mais solicitações",
      ),
    );
    await act(async () => refresh.click());
    await gate.entered.promise;
    expect(f.pending.size).toBe(1);
    const oldWork = required([...f.pending][0]);
    const nativeRequest = required(f.nativeRequests.at(-1));
    const reads = f.request.mock.calls.length;
    await act(async () => {
      f.owner.invalidate(false);
      await f.owner.load();
    });
    await act(async () =>
      f.root.render(
        createElement(
          StrictMode,
          null,
          createElement(WithdrawalSetup, {
            ...f.scope,
            sessionEpoch: f.owner.getSnapshot().sessionEpoch,
            ports: f.ports,
          }),
        ),
      ),
    );
    expect(nativeRequest.signal.aborted).toBe(true);
    for (;;) {
      const issued = f.request.mock.calls.length;
      await act(async () => {
        await Promise.allSettled(
          [...f.pending].filter((work) => work !== oldWork),
        );
      });
      if (
        f.pending.size === 1 &&
        f.pending.has(oldWork) &&
        f.request.mock.calls.length === issued
      )
        break;
    }
    expect(f.pending.has(oldWork)).toBe(true);
    expect(f.pending.size).toBe(1);
    const count = f.request.mock.calls.length;
    const more = required(
      [...f.node.querySelectorAll("button")].find(
        (button) => button.textContent === "Carregar mais solicitações",
      ),
    );
    await act(async () => more.click());
    expect(f.request.mock.calls.length).toBe(count);
    expect(count).toBeGreaterThan(reads);
    const replacement = f.owner.getSnapshot();
    gate.release.resolve();
    await f.settle();
    expect(f.pending.size).toBe(0);
    expect(f.owner.getSnapshot()).toBe(replacement);
    expect(f.node.innerHTML).not.toContain("fr1.");
    expect(f.tables.withdrawal_request).toHaveLength(102);
  });
  it("rejects a real-router exact observation older than its freshly read canonical UNKNOWN floor", async () => {
    const f = await httpWithdrawalHistory(true);
    const intent = required(
      f.tables.withdrawal_intent.find((row) => row.requestId === "history-099"),
    );
    const older = structuredClone(intent);
    older.state = "REQUESTED";
    older.updatedAt = new Date(start + 1).toISOString();
    await httpWithdrawalSelect(f, "history-099");
    expect(f.node.textContent).toContain("Resultado em verificação");
    const marker = [...f.storage.data.values()];
    f.state.exactNativeOverride = older;
    await httpWithdrawalSelect(f, "history-099");
    expect(f.responses.at(-1)).toMatchObject({
      path: "/v1/sites/wedding-a/withdrawals/requests/history-099",
      status: 200,
    });
    expect(f.node.textContent).toContain("Resultado em verificação");
    expect(f.node.querySelector("#withdrawal-amount")).toBeNull();
    expect([...f.storage.data.values()]).toEqual(marker);
    expect(f.tables.withdrawal_intent).toHaveLength(101);
    expect(
      f.tables.withdrawal_request.filter((row) => row.state === "OPEN"),
    ).toHaveLength(1);
  });
  it("rejects another purpose's real proof before any new hold", async () => {
    const f = await withdrawalHttpBridge();
    await httpWithdrawalPreview(f);
    const original = structuredClone(f.tables.withdrawal_request);
    const proof = (await f.request(
      "/v1/sites/wedding-a/financial-reauthentication",
      {
        method: "POST",
        body: { action: "CONFIGURE_RECEIVING", password: "fictional-password" },
      },
    )) as { reauthenticationToken: string };
    await expect(
      f.request("/v1/sites/wedding-a/withdrawals", {
        method: "POST",
        body: {
          action: "CONFIRM_NEW",
          requestId: "request-bridge-a",
          reauthenticationToken: proof.reauthenticationToken,
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.tables.withdrawal_request).toEqual(original);
    expect(f.tables.withdrawal_intent).toHaveLength(0);
    expect(f.tables.financial_operation).toHaveLength(0);
    expect(f.storage.data.size).toBe(1);
  });
  it.each(["cookie", "origin", "revoked", "foreignSite"] as const)(
    "denies financial GET with actual %s authority and no financial effects",
    async (kind) => {
      const f = await withdrawalHttpBridge();
      if (kind === "cookie") f.state.cookie = "";
      if (kind === "origin") f.state.origin = "https://foreign.example.test";
      if (kind === "revoked") f.state.revoked = true;
      const activity = f.state.activity;
      await expect(
        f.request(
          `/v1/sites/${kind === "foreignSite" ? "foreign-site" : access.siteId}/withdrawals/context`,
        ),
      ).rejects.toMatchObject({ status: kind === "cookie" ? 401 : 403 });
      expect(f.state.activity).toBe(activity);
      expect(f.tables.withdrawal_request).toHaveLength(0);
      expect(f.tables.withdrawal_intent).toHaveLength(0);
      expect(f.tables.verification).toHaveLength(0);
      expect(f.responses.at(-1)?.cookie).toBeNull();
    },
  );
});

async function httpWithdrawalClick(
  f: Awaited<ReturnType<typeof withdrawalHttpBridge>>,
  text: string,
) {
  const button = required(
    [...f.node.querySelectorAll("button")].find(
      (value) => value.textContent === text,
    ),
  );
  await act(async () => button.click());
  await f.settle();
}
async function httpWithdrawalSelect(
  f: Awaited<ReturnType<typeof withdrawalHttpBridge>>,
  requestId: string,
) {
  const row = required(
    f.node.querySelector(`[data-request-id="${requestId}"]`),
  );
  const select = row.querySelector<HTMLButtonElement>("button");
  if (select) {
    await act(async () => select.click());
    await f.settle();
  } else await httpWithdrawalClick(f, "Consultar situação");
}
async function httpWithdrawalReserved() {
  const f = await withdrawalHttpBridge();
  await httpWithdrawalPreview(f);
  await httpWithdrawalPassword(f);
  await act(async () =>
    required(
      f.node.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    ).click(),
  );
  await httpWithdrawalClick(f, "Confirmar solicitação de saque");
  expect(f.tables.withdrawal_intent).toHaveLength(1);
  return f;
}
async function httpWithdrawalHistory(unknown = false) {
  const f = await httpWithdrawalReserved();
  const originalRequest = required(f.tables.withdrawal_request[0]);
  const originalIntent = required(f.tables.withdrawal_intent[0]);
  const originalOperation = required(f.tables.financial_operation[0]);
  for (let index = 0; index < 100; index++) {
    const requestId = `history-${String(index).padStart(3, "0")}`;
    const request = structuredClone(originalRequest);
    const intent = structuredClone(originalIntent);
    const operation = structuredClone(originalOperation);
    const originalPreview = structuredClone(
      request.previewSnapshot,
    ) as WithdrawalConsentSnapshot;
    const preview = {
      ...originalPreview,
      preview: { ...originalPreview.preview, requestId },
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "withdrawal.reservation.v1",
          access.siteId,
          requestId,
          "admin-a",
          "sandbox",
          10000,
          3,
        ]),
      )
      .digest("hex");
    Object.assign(intent, {
      id: `intent-${requestId}`,
      requestId,
      requestHash,
    });
    const snapshot = operation.requestSnapshot as {
      requestId: string;
      operationId: string;
      requestHash: string;
      intent: { id: string };
    };
    snapshot.requestId = requestId;
    snapshot.operationId = `operation-${requestId}`;
    snapshot.requestHash = requestHash;
    snapshot.intent.id = intent.id as string;
    Object.assign(operation, {
      id: snapshot.operationId,
      withdrawalIntentId: intent.id,
      requestId,
      requestHash,
    });
    Object.assign(request, {
      id: `association-${requestId}`,
      requestId,
      withdrawalIntentId: intent.id,
      previewSnapshot: preview,
      previewHash: hashWithdrawalConsentSnapshot(preview),
    });
    f.tables.withdrawal_request.push(request);
    f.tables.withdrawal_intent.push(intent);
    f.tables.financial_operation.push(operation);
  }
  const context = (await f.request(
    "/v1/sites/wedding-a/withdrawals/context",
  )) as { context: WithdrawalRequestContext };
  await f.request("/v1/sites/wedding-a/withdrawals/preview", {
    method: "POST",
    body: {
      requestId: "zz-open-original",
      amountCents: 10000,
      scopeRevision: context.context.scopeRevision,
    },
  });
  // A separate clean viewer has no retained action marker; the original viewer keeps its marker.
  if (unknown) {
    vi.setSystemTime(start + 2);
    const intent = required(
      f.tables.withdrawal_intent.find((row) => row.requestId === "history-099"),
    );
    intent.state = "UNKNOWN";
    intent.updatedAt = new Date(start + 2).toISOString();
  }
  const originalMarker = [...f.storage.data.values()];
  const cleanStorage = memory();
  await act(async () =>
    f.root.render(
      createElement(
        StrictMode,
        null,
        createElement(WithdrawalSetup, {
          ...f.scope,
          ports: { ...f.ports, storage: cleanStorage },
        }),
      ),
    ),
  );
  await f.settle();
  expect([...f.storage.data.values()]).toEqual(originalMarker);
  return f;
}

async function httpWithdrawalPreview(
  f: Awaited<ReturnType<typeof withdrawalHttpBridge>>,
) {
  const input = required(
    f.node.querySelector<HTMLInputElement>("#withdrawal-amount"),
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "100,00");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    required(input.closest("form")).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await f.settle();
}
async function httpWithdrawalPassword(
  f: Awaited<ReturnType<typeof withdrawalHttpBridge>>,
) {
  await act(async () =>
    [...f.node.querySelectorAll("button")]
      .find((button) => button.textContent === "Confirmar senha")
      ?.click(),
  );
  const input = required(
    document.querySelector<HTMLInputElement>('input[type="password"]'),
  );
  await act(async () => {
    input.value = "fictional-password";
    required(input.closest("form")).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await f.settle();
  expect(input.value).toBe("");
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounts.push({ root, node });
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(WithdrawalSetup, {
          ...f.scope,
          ports: f.ports,
          onFinancialChange: f.onFinancialChange,
        }),
      ),
    );
  });
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Confirmar senha")
      ?.click(),
  );
  return { root, node };
}

describe("withdrawal setup owned source lifecycle", () => {
  it("notifies financial readers after confirmation and explicit consultation, never automatic reads or previews", async () => {
    const changed = vi.fn();
    const f = await fixture(context(), changed);
    try {
      await f.controller.refresh();
      expect(changed).not.toHaveBeenCalled();
      expect(await f.controller.preview("100")).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      expect(
        await f.controller.act(
          "CONFIRM_NEW",
          () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
          true,
        ),
      ).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      const value = existing();
      f.setRequest(value);
      f.setContext({ ...context("2"), recoverableRequests: [value] });
      await f.controller.refresh();
      expect(changed).toHaveBeenCalledTimes(1);
      await f.controller.refresh(undefined, true);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      f.cleanup();
    }
  });
  it("does not notify financial readers when confirmation or explicit consultation fails", async () => {
    const changed = vi.fn();
    const f = await fixture(openContext(), changed);
    try {
      await f.controller.refresh();
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        options
          ? Promise.reject(new ApiError(503, "WITHDRAWAL_UNAVAILABLE"))
          : native(path, options),
      );
      expect(
        await f.controller.act(
          "CONFIRM_NEW",
          () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
          true,
        ),
      ).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      f.request.mockRejectedValueOnce(
        new ApiError(503, "WITHDRAWAL_UNAVAILABLE"),
      );
      await f.controller.refresh(undefined, true);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("propagates only a successful explicit mounted status consultation", async () => {
    const changed = vi.fn();
    const f = await fixture(context(), changed);
    try {
      const { node } = await mount(f);
      expect(changed).not.toHaveBeenCalled();
      const button = required(
        [...node.querySelectorAll("button")].find(
          (button) => button.textContent === "Consultar situação",
        ),
      );
      await act(async () => button.click());
      expect(changed).toHaveBeenCalledTimes(1);
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("notifies after existing-only recovery without generating a new request", async () => {
    const changed = vi.fn();
    const value = existing();
    const f = await fixture(
      { ...context("2"), recoverableRequests: [value] },
      changed,
    );
    try {
      f.setRequest(value);
      await f.controller.refresh("request-a");
      expect(
        await f.controller.act(
          "RECOVER_EXISTING",
          () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
          true,
        ),
      ).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(f.ports.newRequestId).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("keeps an acknowledged result and Sonner feedback when read invalidation throws", async () => {
    const changed = vi.fn(() => {
      throw new Error("read-only invalidation failed");
    });
    const success = vi.spyOn(toast, "success");
    const f = await fixture(openContext(), changed);
    try {
      await f.controller.refresh();
      expect(
        await f.controller.act(
          "CONFIRM_NEW",
          () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
          true,
        ),
      ).toBe(true);
      expect(f.controller.getState().acknowledgment?.state).toBe("REQUESTED");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(success).toHaveBeenCalledWith(
        "Solicitação registrada. A transferência ainda não foi concluída.",
      );
    } finally {
      f.cleanup();
    }
  });
  it("does not notify another actor after ownership changes during confirmation", async () => {
    const changed = vi.fn();
    const f = await fixture(openContext(), changed);
    const pending = deferred<unknown>();
    const native = required(f.request.getMockImplementation());
    try {
      await f.controller.refresh();
      f.request.mockImplementation((path, options) =>
        options ? pending.promise : native(path, options),
      );
      const work = f.controller.act(
        "CONFIRM_NEW",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      );
      await vi.waitFor(() =>
        expect(
          f.request.mock.calls.filter(([, options]) => options),
        ).toHaveLength(1),
      );
      f.owner.invalidate(false);
      pending.resolve({
        requestId: "request-a",
        withdrawal: existing().withdrawal,
      });
      expect(await work).toBe(false);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  async function failedPreview() {
    const f = await fixture();
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation((path, options) => {
      if (path.endsWith("/preview"))
        throw new ApiError(503, "WITHDRAWAL_UNAVAILABLE");
      return native(path, options);
    });
    await f.controller.refresh();
    expect(await f.controller.preview("100")).toBe(false);
    f.setRequest(unresolved());
    await f.controller.refresh();
    expect(f.controller.canResumePreview()).toBe(true);
    return { ...f, native };
  }
  async function futureCommand(
    command: "preview" | "resume" | "seal",
    aheadMs = 250,
    now?: () => number,
    beforeCommand?: (f: Awaited<ReturnType<typeof fixture>>) => void,
  ) {
    const f =
      command === "resume"
        ? await failedPreview()
        : await fixture(
            command === "seal" ? openContext() : context(),
            undefined,
            now,
          );
    if (command !== "resume") await f.controller.refresh();
    const next: WithdrawalRequestStatus =
      command === "seal"
        ? {
            ...unresolved("2"),
            state: "SEALED_NOT_CREATED",
            scopeRevision: "2",
            requestRevision: "2",
            observationOrder: {
              scopeRevision: "2",
              requestRevision: "2",
              recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
            },
            command: {
              requestId: "request-a",
              amountCents: 10000,
              destinationVersion: 3,
            },
            sealedAt: new Date(start).toISOString(),
          }
        : open();
    next.observedAt = new Date(start + aheadMs).toISOString();
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation((path, options) =>
      path.endsWith(command === "seal" ? "/seal" : "/preview")
        ? Promise.resolve({ request: structuredClone(next) })
        : native(path, options),
    );
    beforeCommand?.(f);
    const work =
      command === "seal"
        ? f.controller.act("SEAL", () => `fr1.cHJvb2Y.${"A".repeat(43)}`, true)
        : command === "resume"
          ? f.controller.resumePreview()
          : f.controller.preview("100");
    await vi.advanceTimersByTimeAsync(0);
    return { ...f, next, work };
  }
  it.each(["preview", "resume", "seal"] as const)(
    "waits once for a fixed %s response without changing its observation or repeating transport",
    async (command) => {
      const success = vi.spyOn(toast, "success");
      const f = await futureCommand(command);
      try {
        const marker = [...f.storage.data.values()];
        const calls = f.request.mock.calls.length;
        expect(f.controller.getState().busy).toBe(true);
        expect(f.controller.getState().uncertain).toBe(true);
        expect(success).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(249);
        expect(f.controller.getState().busy).toBe(true);
        expect([...f.storage.data.values()]).toEqual(marker);
        await vi.advanceTimersByTimeAsync(1);
        expect(await f.work).toBe(true);
        expect(f.controller.getState().request).toEqual(f.next);
        expect(f.controller.getState().uncertain).toBe(false);
        expect(f.request).toHaveBeenCalledTimes(calls);
        expect(f.ports.newRequestId).toHaveBeenCalledTimes(
          command === "seal" ? 0 : 1,
        );
        expect([...f.storage.data.values()]).toEqual(
          command === "seal" ? [] : marker,
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it.each([
    "owner",
    "scope",
    "session",
    "dispose",
    "clock port",
    "transport port",
  ])(
    "does not install a command response when %s changes during its wait",
    async (change) => {
      const success = vi.spyOn(toast, "success");
      const f = await futureCommand("preview");
      try {
        const marker = [...f.storage.data.values()];
        const calls = f.request.mock.calls.length;
        expect(f.controller.getState().busy).toBe(true);
        if (change === "owner") f.owner.invalidate(false);
        if (change === "scope") f.scope.siteId = "another-site";
        if (change === "session")
          vi.setSystemTime(Date.parse(actor.session.expiresAt));
        if (change === "dispose") f.controller.dispose();
        if (change === "clock port") f.ports.now = () => Date.now();
        if (change === "transport port") f.ports.request = vi.fn();
        await vi.advanceTimersByTimeAsync(250);
        expect(await f.work).toBe(false);
        expect(f.controller.getState().request).toBeNull();
        expect(success).not.toHaveBeenCalled();
        expect(f.request).toHaveBeenCalledTimes(calls);
        expect([...f.storage.data.values()]).toEqual(marker);
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(["replaced", "removed", "unreadable"])(
    "preserves a %s retained marker and rejects the response after waiting",
    async (change) => {
      const success = vi.spyOn(toast, "success");
      const f = await futureCommand("preview");
      try {
        expect(f.controller.getState().busy).toBe(true);
        const key = required([...f.storage.data.keys()][0]);
        if (change === "replaced")
          f.storage.data.set(
            key,
            JSON.stringify({
              ...JSON.parse(required(f.storage.data.get(key))),
              requestId: "other",
            }),
          );
        if (change === "removed") f.storage.data.delete(key);
        if (change === "unreadable")
          f.storage.getItem.mockImplementation(() => {
            throw new Error("Storage unavailable");
          });
        const marker = [...f.storage.data.values()];
        await vi.advanceTimersByTimeAsync(250);
        expect(await f.work).toBe(false);
        expect(f.controller.getState().request).toBeNull();
        expect(f.controller.getState().status).toBe("storage_unavailable");
        expect(success).not.toHaveBeenCalled();
        expect([...f.storage.data.values()]).toEqual(marker);
        expect(f.storage.removeItem).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it.each([
    "frozen",
    "backward",
    "overslept",
    "monotonic frozen",
    "monotonic backward",
    "monotonic invalid",
  ])(
    "rejects a %s clock after waiting without accepting future authority",
    async (scenario) => {
      let wall = start;
      let monotonic = 100;
      if (scenario.startsWith("monotonic") || scenario === "overslept")
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const f = await futureCommand("preview", 250, () => wall);
      try {
        expect(f.controller.getState().busy).toBe(true);
        const calls = f.request.mock.calls.length;
        if (scenario === "backward") wall = start - 1;
        if (scenario === "overslept") {
          wall = start + 250;
          monotonic += 1251;
        }
        if (scenario === "monotonic backward") {
          wall = start + 250;
          monotonic -= 1;
        }
        if (scenario === "monotonic frozen") wall = start + 250;
        if (scenario === "monotonic invalid") {
          wall = start + 250;
          monotonic = Number.NaN;
        }
        await vi.advanceTimersByTimeAsync(250);
        expect(await f.work).toBe(false);
        expect(f.controller.getState().request).toBeNull();
        expect(f.controller.guard.isCurrent()).toBe(false);
        expect(f.request).toHaveBeenCalledTimes(calls);
        expect(f.storage.data.size).toBe(1);
      } finally {
        f.cleanup();
      }
    },
  );
  it("rejects excessive command clock lead without scheduling a wait", async () => {
    const f = await futureCommand("preview", 1001);
    try {
      expect(await f.work).toBe(false);
      expect(f.controller.getState().request).toBeNull();
      expect(f.controller.getState().uncertain).toBe(true);
      const calls = f.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1250);
      expect(f.controller.getState().request).toBeNull();
      expect(f.request).toHaveBeenCalledTimes(calls);
    } finally {
      f.cleanup();
    }
  });
  it("accepts the bounded maximum command clock lead only once the browser reaches it", async () => {
    const f = await futureCommand("preview", 1000);
    try {
      expect(f.controller.getState().busy).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.controller.getState().request).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.work).toBe(true);
      expect(f.controller.getState().request).toEqual(f.next);
    } finally {
      f.cleanup();
    }
  });
  it("keeps an OPEN that expires during its wait recoverable without authorizing confirmation", async () => {
    let wall = start;
    const f = await futureCommand("preview", 250, () => wall);
    try {
      expect(f.controller.getState().busy).toBe(true);
      wall = start + 60000;
      await vi.advanceTimersByTimeAsync(250);
      expect(await f.work).toBe(true);
      expect(f.controller.getState().request).toEqual(f.next);
      expect(f.controller.guard.isCurrent()).toBe(true);
      const calls = f.request.mock.calls.length;
      const proof = vi.fn(() => `fr1.cHJvb2Y.${"A".repeat(43)}`);
      expect(await f.controller.act("CONFIRM_NEW", proof, true)).toBe(false);
      expect(proof).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledTimes(calls);
      expect(f.storage.data.size).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  it("rechecks the exact marker after final clock callbacks during command admission", async () => {
    let afterRead = false;
    let replace = () => {};
    const f = await futureCommand("preview", 250, () => {
      if (afterRead) replace();
      return Date.now();
    });
    try {
      expect(f.controller.getState().busy).toBe(true);
      const key = required([...f.storage.data.keys()][0]);
      const replacement = JSON.stringify({
        ...JSON.parse(required(f.storage.data.get(key))),
        requestId: "other",
      });
      replace = () => f.storage.data.set(key, replacement);
      f.storage.getItem.mockImplementation((selected) => {
        const value = f.storage.data.get(selected) ?? null;
        afterRead = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(await f.work).toBe(false);
      expect(f.controller.getState().request).toBeNull();
      expect(f.storage.data.get(key)).toBe(replacement);
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each([
    ["preview", 0, "replaced"],
    ["preview", 0, "removed"],
    ["preview", 250, "replaced"],
    ["preview", 250, "removed"],
    ["seal", 0, "replaced"],
    ["seal", 0, "removed"],
    ["seal", 250, "replaced"],
    ["seal", 250, "removed"],
  ] as const)(
    "rejects %s with %sms lead when its marker is %s before synchronous publication",
    async (command, aheadMs, change) => {
      const success = vi.spyOn(toast, "success");
      let expected: string | null = null;
      const f = await futureCommand(command, aheadMs, undefined, (f) => {
        const mutate = () => {
          const key = required([...f.storage.data.keys()][0]);
          if (change === "removed") f.storage.data.delete(key);
          else {
            expected = JSON.stringify({
              ...JSON.parse(required(f.storage.data.get(key))),
              requestId: "other",
            });
            f.storage.data.set(key, expected);
          }
        };
        if (aheadMs) {
          let samples = 0;
          vi.spyOn(performance, "now").mockImplementation(() => {
            if (++samples === 2) queueMicrotask(mutate);
            return Date.now() - start;
          });
        } else {
          const native = required(f.request.getMockImplementation());
          f.request.mockImplementation(async (path, options) => {
            const response = await native(path, options);
            if (options?.method === "POST") queueMicrotask(mutate);
            return response;
          });
        }
      });
      try {
        await vi.advanceTimersByTimeAsync(aheadMs);
        expect(await f.work).toBe(false);
        expect(f.controller.getState().request?.state).not.toBe(
          command === "seal" ? "SEALED_NOT_CREATED" : "OPEN",
        );
        expect(f.controller.getState().uncertain).toBe(true);
        expect(success).not.toHaveBeenCalled();
        expect([...f.storage.data.values()]).toEqual(
          expected ? [expected] : [],
        );
        expect(f.storage.removeItem).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(["transport", "clock", "storage", "scope", "session epoch"])(
    "rejects a %s change in the final marker-read callback before command publication",
    async (change) => {
      const success = vi.spyOn(toast, "success");
      const f = await futureCommand("preview");
      try {
        let reads = 0;
        f.storage.getItem.mockImplementation((key) => {
          const value = f.storage.data.get(key) ?? null;
          if (++reads === 2) {
            if (change === "transport") f.ports.request = vi.fn();
            if (change === "clock") f.ports.now = () => Date.now();
            if (change === "storage") f.ports.storage = memory();
            if (change === "scope") f.scope.siteId = "another-site";
            if (change === "session epoch")
              f.scope.sessionEpoch = required(f.scope.sessionEpoch) + 1;
          }
          return value;
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(await f.work).toBe(false);
        expect(f.controller.getState().request).toBeNull();
        expect(success).not.toHaveBeenCalled();
        expect(f.storage.data.size).toBe(1);
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(["legacy", "scope", "command", "record", "mode", "blocked", "clock"])(
    "does not resume an unverifiable %s preview",
    async (scenario) => {
      const f = await failedPreview();
      const before = required([...f.storage.data.values()][0]);
      if (scenario === "legacy") {
        const marker = JSON.parse(before);
        delete marker.previewInput;
        marker.version = 1;
        f.storage.data.set(
          required([...f.storage.data.keys()][0]),
          JSON.stringify(marker),
        );
      }
      if (scenario === "scope") {
        f.setContext(context("1"));
        f.setRequest(unresolved("1"));
      }
      if (scenario === "command")
        f.setRequest({
          ...unresolved(),
          command: {
            requestId: "request-a",
            amountCents: 10000,
            destinationVersion: 3,
          },
        });
      if (scenario === "record")
        f.setRequest({
          ...unresolved(),
          observationOrder: {
            ...unresolved().observationOrder,
            recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n),
          },
        });
      if (scenario === "mode") f.setContext({ ...context(), mode: "live" });
      if (scenario === "blocked")
        f.setContext({
          ...context(),
          newRequestAllowed: false,
          reason: "DESTINATION_UNAVAILABLE",
        });
      if (scenario === "clock") vi.setSystemTime(start - 1);
      await f.controller.refresh();
      expect(f.controller.canResumePreview()).toBe(false);
      expect(await f.controller.resumePreview()).toBe(false);
      expect(
        f.request.mock.calls.filter(([, options]) => options),
      ).toHaveLength(1);
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(f.ports.newRequestId).toHaveBeenCalledTimes(1);
      f.cleanup();
    },
  );
  it.each(["error", "amount", "site", "older", "excessive future"])(
    "keeps the original correlation after a resumed preview %s",
    async (scenario) => {
      const f = await failedPreview();
      const marker = required([...f.storage.data.values()][0]);
      f.request.mockImplementation((path, options) => {
        if (!path.endsWith("/preview")) return f.native(path, options);
        if (scenario === "error")
          throw new ApiError(503, "WITHDRAWAL_UNAVAILABLE");
        const value = open();
        if (scenario === "amount") {
          value.preview.amountCents = 20000;
          value.preview.netCents = 19750;
        }
        if (scenario === "site") {
          value.siteId = "another";
          value.preview.siteId = "another";
        }
        if (scenario === "older") {
          value.scopeRevision = "0";
          value.observationOrder.scopeRevision = "0";
        }
        if (scenario === "excessive future")
          value.observedAt = new Date(start + 1001).toISOString();
        return Promise.resolve({ request: value });
      });
      expect(await f.controller.resumePreview()).toBe(false);
      expect(f.controller.getState().uncertain).toBe(true);
      expect(f.controller.getState().request?.state).toBe("UNRESOLVED");
      expect([...f.storage.data.values()]).toEqual([marker]);
      expect(f.ports.newRequestId).toHaveBeenCalledTimes(1);
      f.cleanup();
    },
  );
  it("consults an already registered preview without replay and preserves v2 through confirmation", async () => {
    const f = await failedPreview();
    const marker = required([...f.storage.data.values()][0]);
    f.request.mockImplementation(f.native);
    f.setContext(openContext());
    f.setRequest(open());
    await f.controller.refresh();
    expect(await f.controller.resumePreview()).toBe(false);
    const consume = vi.fn(() => `fr1.cHJvb2Y.${"A".repeat(43)}`);
    expect(await f.controller.act("CONFIRM_NEW", consume, true)).toBe(true);
    expect(consume).toHaveBeenCalledTimes(1);
    expect([...f.storage.data.values()]).toEqual([marker]);
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/preview")),
    ).toHaveLength(1);
    f.cleanup();
  });
  it("keeps v2 through explicit sealing and retires only that exact marker", async () => {
    const f = await failedPreview();
    f.setContext(openContext());
    f.setRequest(open());
    await f.controller.refresh();
    f.request.mockImplementation((path, options) =>
      path.endsWith("/seal")
        ? Promise.resolve({
            request: {
              ...unresolved("2"),
              state: "SEALED_NOT_CREATED",
              requestRevision: "2",
              observationOrder: {
                scopeRevision: "2",
                requestRevision: "2",
                recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n),
              },
              command: {
                requestId: "request-a",
                amountCents: 10000,
                destinationVersion: 3,
              },
              sealedAt: new Date(start).toISOString(),
            },
          })
        : f.native(path, options),
    );
    expect(
      await f.controller.act(
        "SEAL",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      ),
    ).toBe(true);
    expect(f.storage.data.size).toBe(0);
    f.cleanup();
  });
  it("waits for an outstanding page before admitting a resumed preview", async () => {
    const f = await failedPreview();
    f.setContext({ ...context(), nextCursor: "next-page" });
    await f.controller.refresh();
    const page = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path.includes("?cursor=") ? page.promise : f.native(path, options),
    );
    const work = f.controller.loadMore();
    expect(await f.controller.resumePreview()).toBe(false);
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      1,
    );
    page.resolve({ context: context() });
    await work;
    f.cleanup();
  });
  it("rechecks the original scope immediately before a resumed dispatch", async () => {
    const f = await failedPreview();
    f.setContext(context("1"));
    f.setRequest(unresolved("1"));
    expect(await f.controller.resumePreview()).toBe(false);
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      1,
    );
    expect(f.storage.data.size).toBe(1);
    f.cleanup();
  });
  it("requires a fresh read after repeated preview failure and keeps proof unavailable", async () => {
    const f = await failedPreview();
    const error = vi.spyOn(toast, "error");
    const before = required([...f.storage.data.values()][0]);
    expect(await f.controller.resumePreview()).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "Não foi possível consultar a prévia. Consulte a situação antes de tentar novamente.",
    );
    expect(f.controller.canResumePreview()).toBe(false);
    expect(f.controller.guard.isCurrent()).toBe(false);
    await f.controller.refresh();
    expect(f.controller.canResumePreview()).toBe(true);
    expect([...f.storage.data.values()]).toEqual([before]);
    f.cleanup();
  });
  it("does not resume across a marker replacement during fresh reads", async () => {
    const f = await failedPreview();
    const key = required([...f.storage.data.keys()][0]);
    const changed = JSON.stringify({
      ...JSON.parse(required(f.storage.data.get(key))),
      requestId: "other",
      previewInput: {
        requestId: "other",
        amountCents: 20000,
        scopeRevision: "0",
      },
    });
    f.request.mockImplementation((path, options) => {
      if (path.includes("/requests/")) f.storage.data.set(key, changed);
      return f.native(path, options);
    });
    expect(await f.controller.resumePreview()).toBe(false);
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      1,
    );
    expect(f.storage.data.get(key)).toBe(changed);
    f.cleanup();
  });
  it("does not dispatch when the final retained-marker read invalidates the owner", async () => {
    const f = await failedPreview();
    const proofRevision = f.controller.getState().proofRevision;
    f.changed.mockImplementation((state) => {
      if (state.busy && state.proofRevision > proofRevision) {
        f.storage.getItem.mockImplementation((key) => {
          f.owner.invalidate(false);
          return f.storage.data.get(key) ?? null;
        });
      }
    });
    expect(await f.controller.resumePreview()).toBe(false);
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      1,
    );
    expect(f.controller.getState().status).toBe("denied");
    f.cleanup();
  });
  it("does not publish a resumed response after owner invalidation", async () => {
    const f = await failedPreview();
    const pending = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path.endsWith("/preview") ? pending.promise : f.native(path, options),
    );
    const work = f.controller.resumePreview();
    await vi.waitFor(() =>
      expect(
        f.request.mock.calls.filter(([path]) => path.endsWith("/preview")),
      ).toHaveLength(2),
    );
    f.owner.invalidate(false);
    pending.resolve({ request: open() });
    expect(await work).toBe(false);
    expect(f.controller.getState().status).toBe("denied");
    expect(f.storage.data.size).toBe(1);
    f.cleanup();
  });
  it("resumes only the preserved preview after a failed dispatch and actual remount", async () => {
    const f = await fixture();
    const native = required(f.request.getMockImplementation());
    const pending = deferred<unknown>();
    let previews = 0;
    f.request.mockImplementation((path, options) => {
      if (path.endsWith("/preview")) {
        previews++;
        if (previews === 1) throw new ApiError(503, "WITHDRAWAL_UNAVAILABLE");
        return pending.promise;
      }
      return native(path, options);
    });
    await f.controller.refresh();
    expect(await f.controller.preview("100")).toBe(false);
    const body = {
      requestId: "request-a",
      amountCents: 10000,
      scopeRevision: "0",
    };
    const marker = JSON.parse(required([...f.storage.data.values()][0]));
    expect(marker).toEqual({
      version: 2,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
      previewInput: body,
    });
    f.setRequest({
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: "0",
      requestRevision: null,
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "0",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      command: null,
    });
    f.controller.dispose();
    const success = vi.spyOn(toast, "success");
    const { node } = await mount(f);
    expect(previews).toBe(1);
    const resume = required(
      [...node.querySelectorAll("button")].find(
        (button) => button.textContent === "Retomar prévia",
      ),
    );
    expect(node.querySelector("#withdrawal-amount")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await act(async () => resume.click());
    expect(resume.disabled).toBe(true);
    expect(node.textContent).toContain("Retomando prévia…");
    await act(async () => resume.click());
    expect(previews).toBe(2);
    expect(
      f.request.mock.calls
        .filter(([path]) => path.endsWith("/preview"))
        .map(([, options]) => options?.body),
    ).toEqual([body, body]);
    await act(async () => pending.resolve({ request: open() }));
    expect(success).toHaveBeenCalledWith(
      "Prévia pronta. Confira o destino, os valores e a validade antes de confirmar.",
    );
    expect(node.textContent).toContain("100,00");
    expect(f.ports.newRequestId).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls
        .filter(([, options]) => options)
        .every(([path]) => path.endsWith("/preview")),
    ).toBe(true);
    expect(JSON.parse(required([...f.storage.data.values()][0]))).toEqual(
      marker,
    );
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(node.textContent).toContain("Prévia expirada");
    f.cleanup();
  });
  it("keeps automatic reads quiet and reports an explicit successful refresh", async () => {
    const success = vi.spyOn(toast, "success");
    const f = await fixture();
    try {
      await f.controller.refresh();
      expect(success).not.toHaveBeenCalled();
      await f.controller.refresh(undefined, true);
      expect(success).toHaveBeenCalledWith(
        "Situação atualizada. Você pode consultar uma prévia.",
      );
    } finally {
      f.cleanup();
    }
  });
  it("reports invalid amounts and only reports a preview after its response", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const f = await fixture();
    try {
      await f.controller.refresh();
      expect(await f.controller.preview("invalid")).toBe(false);
      expect(error).toHaveBeenCalledWith(
        "Informe um valor válido para o saque.",
      );
      expect(success).not.toHaveBeenCalled();
      expect(await f.controller.preview("100")).toBe(true);
      expect(success).toHaveBeenCalledWith(
        "Prévia pronta. Confira o destino, os valores e a validade antes de confirmar.",
      );
    } finally {
      f.cleanup();
    }
  });
  it("reports a failed preview fee lookup without announcing success", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const f = await fixture();
    try {
      await f.controller.refresh();
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) => {
        if (path.endsWith("/preview"))
          throw new ApiError(409, "FEE_QUOTE_UNAVAILABLE");
        return native(path, options);
      });
      expect(await f.controller.preview("100")).toBe(false);
      expect(error).toHaveBeenCalledWith(
        "Não foi possível consultar a taxa. Consulte a situação antes de tentar novamente.",
      );
      expect(success).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each([
    [
      "PREVIEW_EXPIRED",
      "A prévia expirou. Encerre a solicitação sem reserva e consulte uma nova prévia.",
    ],
    [
      "REQUEST_CONFLICT",
      "Os termos mudaram. Consulte a solicitação original antes de continuar.",
    ],
  ])(
    "reports %s confirmation failures without replacing the original request",
    async (code, message) => {
      const error = vi.spyOn(toast, "error");
      const f = await fixture(openContext());
      try {
        await f.controller.refresh();
        const native = required(f.request.getMockImplementation());
        f.request.mockImplementation((path, options) => {
          if (options?.method === "POST" && path.endsWith("/withdrawals"))
            throw new ApiError(409, code);
          return native(path, options);
        });
        expect(
          await f.controller.act(
            "CONFIRM_NEW",
            () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
            true,
          ),
        ).toBe(false);
        expect(error).toHaveBeenCalledWith(message);
        expect(f.controller.getState().request?.requestId).toBe("request-a");
        expect(f.ports.newRequestId).not.toHaveBeenCalled();
        expect(
          f.request.mock.calls.filter(
            ([, options]) => options?.method === "POST",
          ),
        ).toHaveLength(1);
      } finally {
        f.cleanup();
      }
    },
  );
  it("requires password proof before announcing a withdrawal result", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const f = await fixture(openContext());
    try {
      await f.controller.refresh();
      expect(await f.controller.act("CONFIRM_NEW", () => null, true)).toBe(
        false,
      );
      expect(error).toHaveBeenCalledWith(
        "Confirme sua senha antes de continuar.",
      );
      expect(success).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.every(([, options]) => !options?.method),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it.each(["REQUESTED", "UNKNOWN", "COMPLETED"] as const)(
    "reports the actual %s acknowledgment without inventing bank credit",
    async (state) => {
      const success = vi.spyOn(toast, "success");
      const warning = vi.spyOn(toast, "warning");
      const f = await fixture(openContext());
      try {
        await f.controller.refresh();
        const native = required(f.request.getMockImplementation());
        f.request.mockImplementation((path, options) =>
          path.endsWith("/withdrawals") && options?.method === "POST"
            ? Promise.resolve({
                requestId: "request-a",
                withdrawal: { ...existing().withdrawal, state },
              })
            : native(path, options),
        );
        expect(
          await f.controller.act(
            "CONFIRM_NEW",
            () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
            true,
          ),
        ).toBe(true);
        if (state === "UNKNOWN") {
          expect(warning).toHaveBeenCalledWith(
            "Resultado em verificação. Consulte a solicitação original antes de qualquer nova tentativa.",
          );
          expect(success).not.toHaveBeenCalled();
        } else
          expect(success).toHaveBeenCalledWith(
            state === "COMPLETED"
              ? "Saque concluído pelo provedor."
              : "Solicitação registrada. A transferência ainda não foi concluída.",
          );
      } finally {
        f.cleanup();
      }
    },
  );
  it("does not notify for a delayed preview after its owner is disposed", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const f = await fixture();
    const pending = deferred<unknown>();
    try {
      await f.controller.refresh();
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.endsWith("/preview") ? pending.promise : native(path, options),
      );
      const work = f.controller.preview("100");
      await vi.advanceTimersByTimeAsync(0);
      f.controller.dispose();
      pending.resolve({ request: open() });
      expect(await work).toBe(false);
      expect(success).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("refreshes newer derived admission without replacing the original withdrawal revision", async () => {
    const blocked: WithdrawalRequestContext = {
      ...context(),
      newRequestAllowed: false,
      reason: "DESTINATION_UNAVAILABLE",
    };
    const f = await fixture(blocked);
    try {
      await f.controller.refresh();
      expect(f.controller.getState().status).toBe("ready");
      vi.setSystemTime(start + 1000);
      f.setContext({
        ...context(),
        observedAt: new Date(start + 1000).toISOString(),
      });
      await f.controller.refresh();
      expect(f.controller.getState()).toMatchObject({
        status: "ready",
        context: { scopeRevision: "0", newRequestAllowed: true, reason: null },
      });
      vi.setSystemTime(start + 2000);
      f.setContext({
        ...blocked,
        observedAt: new Date(start + 2000).toISOString(),
      });
      await f.controller.refresh();
      expect(f.controller.getState()).toMatchObject({
        status: "ready",
        context: {
          scopeRevision: "0",
          newRequestAllowed: false,
          reason: "DESTINATION_UNAVAILABLE",
        },
      });
      expect(
        f.request.mock.calls.every(([, options]) => !options?.method),
      ).toBe(true);
      expect(f.ports.newRequestId).not.toHaveBeenCalled();
      expect(f.storage.setItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("keeps denial when a storage getter loses the owner and then throws", async () => {
    const f = await fixture(openContext());
    f.storage.getItem.mockImplementation(() => {
      f.owner.invalidate(false);
      throw new Error("storage denied");
    });
    await f.controller.refresh();
    expect(f.controller.getState().status).toBe("denied");
    expect(f.controller.getState().request).toBeNull();
    expect(f.request.mock.calls).toEqual([
      ["/v1/sites/wedding-a/withdrawals/context"],
    ]);
    f.cleanup();
  });
  it("does not republish a sealed result when marker retirement loses ownership", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const native = required(f.request.getMockImplementation());
    const sealed: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      scopeRevision: "2",
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "2",
        requestRevision: "2",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
      },
      command: {
        requestId: "request-a",
        amountCents: 10000,
        destinationVersion: 3,
      },
      sealedAt: new Date(start).toISOString(),
    };
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/seal") ? { request: sealed } : native(path, options),
    );
    f.storage.removeItem.mockImplementation((key) => {
      f.storage.data.delete(key);
      f.owner.invalidate(false);
    });
    expect(
      await f.controller.act(
        "SEAL",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      ),
    ).toBe(false);
    expect(f.controller.getState().status).toBe("denied");
    expect(f.controller.getState().request).toBeNull();
    f.cleanup();
  });
  it("a successful reservation acknowledgment cannot later return to OPEN", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    expect(
      await f.controller.act(
        "CONFIRM_NEW",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      ),
    ).toBe(true);
    const later = {
      ...open(),
      scopeRevision: "2",
      observationOrder: {
        ...open().observationOrder,
        scopeRevision: "2",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
      },
    };
    f.setContext({
      ...openContext(later),
      scopeRevision: "2",
      observationOrder: {
        scopeRevision: "2",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
    });
    f.setRequest(later);
    await f.controller.refresh();
    expect(f.controller.getState().status).toBe("unavailable");
    expect(f.controller.guard.isCurrent()).toBe(false);
    expect(f.storage.data.size).toBe(1);
    f.cleanup();
  });
  it("does not dispatch after a final marker read synchronously loses the owner", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    let consumed = false;
    f.storage.getItem.mockImplementation((key) => {
      const value = f.storage.data.get(key) ?? null;
      if (consumed) f.owner.invalidate(false);
      return value;
    });
    await f.controller.act(
      "CONFIRM_NEW",
      () => {
        consumed = true;
        return `fr1.cHJvb2Y.${"A".repeat(43)}`;
      },
      true,
    );
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(f.storage.data.size).toBe(1);
    f.cleanup();
  });
  it("never returns a known committed request to OPEN after newer uncertainty", async () => {
    const prior = {
      ...existing(),
      preview: null,
      requestRevision: null,
      observationOrder: {
        ...existing().observationOrder,
        requestRevision: null,
      },
    };
    const f = await fixture({ ...context("2"), recoverableRequests: [prior] });
    await f.controller.refresh("request-a");
    const pending: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: "3",
      requestRevision: null,
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "3",
        requestRevision: null,
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 2n),
      },
      command: prior.command,
    };
    f.setContext({
      ...context("3"),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
      recoverableRequests: [pending],
    });
    f.setRequest(pending);
    await f.controller.refresh("request-a");
    const resurrected = {
      ...open(),
      scopeRevision: "4",
      observationOrder: {
        ...open().observationOrder,
        scopeRevision: "4",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 3n),
      },
    };
    f.setContext({
      ...openContext(resurrected),
      scopeRevision: "4",
      observationOrder: {
        scopeRevision: "4",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
    });
    f.setRequest(resurrected);
    await f.controller.refresh("request-a");
    expect(f.controller.getState().status).toBe("unavailable");
    expect(f.controller.guard.isCurrent()).toBe(false);
    f.cleanup();
  });
  it("cannot retire another tab's unknown marker using an older selected known request", async () => {
    const prior = existing();
    const f = await fixture({ ...context("2"), recoverableRequests: [prior] });
    await f.controller.refresh("request-a");
    const pending: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-b",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: "3",
      requestRevision: null,
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "3",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      command: null,
    };
    const currentPrior = {
      ...prior,
      scopeRevision: "3",
      observationOrder: { ...prior.observationOrder, scopeRevision: "3" },
    };
    f.setContext({
      ...context("3"),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
      recoverableRequests: [pending, currentPrior],
    });
    const { withdrawalMarkerKey } = await import("./withdrawalClient");
    f.storage.data.set(
      withdrawalMarkerKey(access.siteId, access.userId),
      JSON.stringify({
        version: 1,
        siteId: access.siteId,
        operatorUserId: access.userId,
        mode: "sandbox",
        requestId: "request-b",
      }),
    );
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/requests/request-b")
        ? { request: pending }
        : path.endsWith("/requests/request-a")
          ? { request: currentPrior }
          : native(path, options),
    );
    await f.controller.refresh("request-a");
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect([...f.storage.data.values()][0]).toContain("request-b");
    f.cleanup();
  });
  it("retires only the exact marker after an authoritative newer seal", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const native = required(f.request.getMockImplementation());
    const sealed: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      scopeRevision: "2",
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "2",
        requestRevision: "2",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
      },
      command: {
        requestId: "request-a",
        amountCents: 10000,
        destinationVersion: 3,
      },
      sealedAt: new Date(start).toISOString(),
    };
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/seal") ? { request: sealed } : native(path, options),
    );
    const token = `fr1.cHJvb2Y.${"A".repeat(43)}`;
    expect(await f.controller.act("SEAL", () => token, true)).toBe(true);
    expect(f.request.mock.calls.filter(([, options]) => options)).toEqual([
      [
        "/v1/sites/wedding-a/withdrawals/request-a/seal",
        { method: "POST", body: { reauthenticationToken: token } },
      ],
    ]);
    expect(f.storage.data.size).toBe(0);
    expect(f.controller.getState().request?.state).toBe("SEALED_NOT_CREATED");
    f.cleanup();
  });
  it("allows a distinct later same-amount lifecycle after authoritative known recovery", async () => {
    const prior = existing();
    const f = await fixture({ ...context("2"), recoverableRequests: [prior] });
    await f.controller.refresh("request-a");
    const native = required(f.request.getMockImplementation());
    f.ports.newRequestId.mockReturnValue("request-b");
    const next = {
      ...open("request-b"),
      scopeRevision: "3",
      observationOrder: { ...open().observationOrder, scopeRevision: "3" },
    };
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/preview") ? { request: next } : native(path, options),
    );
    expect(await f.controller.preview("100,00")).toBe(true);
    expect(f.controller.getState().request?.requestId).toBe("request-b");
    expect([...f.storage.data.values()][0]).toContain("request-b");
    f.cleanup();
  });
  it("ignores stale401 after a fresh owner has replaced its captured generation", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    const consume = vi.fn();
    const work = f.controller.act("CONFIRM_NEW", consume, true);
    await Promise.resolve();
    f.owner.invalidate(false);
    await f.owner.load();
    const replacement = f.owner.getSnapshot();
    pending.reject(new ApiError(401, "UNAUTHORIZED"));
    await work;
    expect(f.owner.getSnapshot()).toBe(replacement);
    expect(consume).not.toHaveBeenCalled();
    f.cleanup();
  });
  it("missing exact rows and incomplete paging never replace retained correlation", async () => {
    const f = await fixture({ ...context(), nextCursor: "next-page" });
    const { writeWithdrawalMarker } = await import("./withdrawalClient");
    writeWithdrawalMarker(f.storage, {
      version: 1,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
    });
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) => {
      if (path.includes("/requests/")) throw new ApiError(404, "NOT_FOUND");
      return native(path, options);
    });
    await f.controller.refresh();
    expect(f.controller.getState().status).toBe("unavailable");
    expect(await f.controller.preview("100")).toBe(false);
    expect(f.storage.data.size).toBe(1);
    expect(f.controller.getState().uncertain).toBe(true);
    expect(f.ports.newRequestId).not.toHaveBeenCalled();
    f.cleanup();
  });
  it("does not dispatch exact lookup after a synchronous storage getter loses ownership", async () => {
    const f = await fixture(openContext());
    f.storage.getItem.mockImplementation(() => {
      f.owner.invalidate(false);
      return JSON.stringify({
        version: 1,
        siteId: access.siteId,
        operatorUserId: access.userId,
        mode: "sandbox",
        requestId: "request-a",
      });
    });
    await f.controller.refresh();
    expect(f.request.mock.calls).toEqual([
      ["/v1/sites/wedding-a/withdrawals/context"],
    ]);
    f.cleanup();
  });
  it("explicitly selects a server OPEN after rechecking a known historical marker", async () => {
    const old = existing();
    const next = {
      ...open("request-b"),
      scopeRevision: "3",
      observationOrder: { ...open().observationOrder, scopeRevision: "3" },
    };
    const prior = {
      ...old,
      scopeRevision: "3",
      observationOrder: { ...old.observationOrder, scopeRevision: "3" },
    };
    const serverContext = {
      ...openContext(next),
      scopeRevision: "3",
      observationOrder: {
        scopeRevision: "3",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      recoverableRequests: [prior],
    };
    const f = await fixture(serverContext);
    const { writeWithdrawalMarker } = await import("./withdrawalClient");
    writeWithdrawalMarker(f.storage, {
      version: 1,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
    });
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/requests/request-a")
        ? { request: prior }
        : path.endsWith("/requests/request-b")
          ? { request: next }
          : native(path, options),
    );
    await f.controller.refresh();
    expect(f.controller.getState().request?.requestId).toBe("request-a");
    await f.controller.refresh("request-b");
    expect(f.controller.getState().status).toBe("ready");
    expect(f.controller.getState().request?.requestId).toBe("request-b");
    expect(f.storage.data.size).toBe(0);
    expect(f.request.mock.calls.some(([path]) => path === "/v1/me")).toBe(true);
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.cleanup();
  });
  it("waits for a bounded context observation before displaying the mounted withdrawal form", async () => {
    const f = await fixture({
      ...context(),
      observedAt: new Date(start + 500).toISOString(),
    });
    try {
      const { node } = await mount(f);
      const calls = f.request.mock.calls.length;
      expect(node.querySelector("#withdrawal-amount")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(499));
      expect(node.querySelector("#withdrawal-amount")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(node.querySelector("#withdrawal-amount")).not.toBeNull();
      expect(f.request).toHaveBeenCalledTimes(calls);
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("waits for context and exact request observations during consent revalidation", async () => {
    const f = await fixture(openContext());
    try {
      await f.controller.refresh();
      const next = open();
      next.observedAt = new Date(start + 1000).toISOString();
      f.setContext({
        ...openContext(),
        observedAt: new Date(start + 500).toISOString(),
      });
      f.setRequest(next);
      const work = f.controller.guard.validate();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(f.controller.getState().request?.observedAt).not.toBe(
        next.observedAt,
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(await work).toBe(true);
      expect(f.controller.getState().request).toEqual(next);
      expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("discards a bounded context wait when its actor is revoked", async () => {
    const f = await fixture({
      ...context(),
      observedAt: new Date(start + 500).toISOString(),
    });
    try {
      const work = f.controller.refresh();
      await vi.advanceTimersByTimeAsync(0);
      f.owner.invalidate(false);
      await vi.advanceTimersByTimeAsync(500);
      await work;
      expect(f.controller.getState().status).toBe("denied");
      expect(f.controller.getState().context).toBeNull();
    } finally {
      f.cleanup();
    }
  });
  it("rejects a bounded observation when the wall clock does not advance", async () => {
    const f = await fixture(
      {
        ...context(),
        observedAt: new Date(start + 500).toISOString(),
      },
      undefined,
      () => start,
    );
    try {
      const work = f.controller.refresh();
      await vi.advanceTimersByTimeAsync(500);
      await work;
      expect(f.controller.getState().status).toBe("unavailable");
      expect(f.controller.getState().context).toBeNull();
    } finally {
      f.cleanup();
    }
  });
  it("rejects an excessive future server observation instead of installing authority", async () => {
    const f = await fixture({
      ...context(),
      observedAt: new Date(start + 1001).toISOString(),
    });
    await f.controller.refresh();
    expect(f.controller.getState().status).toBe("unavailable");
    f.cleanup();
  });
  it("reports an initially unavailable context through Sonner", async () => {
    const error = vi.spyOn(toast, "error");
    const f = await fixture({
      ...context(),
      observedAt: new Date(start + 1001).toISOString(),
    });
    try {
      const { node } = await mount(f);
      expect(error).toHaveBeenCalledWith(
        "Não foi possível verificar a situação do saque. Consulte novamente.",
      );
      expect(node.querySelector("#withdrawal-amount")).toBeNull();
    } finally {
      f.cleanup();
    }
  });
  it("retracts proof holders at the preview deadline without polling", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const invalidated = vi.fn();
    f.controller.guard.subscribeInvalidation(invalidated);
    const calls = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(calls);
    f.cleanup();
  });
  it("blocks a marker replaced synchronously while the proof is consumed", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    await f.controller.act(
      "CONFIRM_NEW",
      () => {
        for (const [key, value] of f.storage.data)
          f.storage.data.set(
            key,
            JSON.stringify({
              ...JSON.parse(value),
              requestId: "other-request",
            }),
          );
        return `fr1.cHJvb2Y.${"A".repeat(43)}`;
      },
      true,
    );
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(f.controller.getState().status).toBe("storage_unavailable");
    expect([...f.storage.data.values()][0]).toContain("other-request");
    f.cleanup();
  });
  it("does not retire a known marker when a purported fresh ID repeats its predecessor", async () => {
    const prior = existing();
    const f = await fixture({ ...context("2"), recoverableRequests: [prior] });
    await f.controller.refresh("request-a");
    const { writeWithdrawalMarker } = await import("./withdrawalClient");
    writeWithdrawalMarker(f.storage, {
      version: 1,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
    });
    await f.controller.refresh();
    expect(await f.controller.preview("100")).toBe(false);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.cleanup();
  });
  it("initial discovery is GET-only and does not invent a request or write storage", async () => {
    const f = await fixture();
    await f.controller.refresh();
    expect(f.request.mock.calls).toEqual([
      ["/v1/sites/wedding-a/withdrawals/context"],
    ]);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.ports.newRequestId).not.toHaveBeenCalled();
    expect(f.controller.getState().context).toEqual(context());
    f.cleanup();
  });
  it("keeps nullable epoch and foreign access locked without a request", async () => {
    const f = await fixture();
    const c = createWithdrawalSetupController(
      { ...f.scope, sessionEpoch: null },
      vi.fn(),
      f.ports,
    );
    await c.refresh();
    expect(f.request).not.toHaveBeenCalled();
    expect(c.getState().status).toBe("denied");
    c.dispose();
    f.cleanup();
  });
  it("strictly blocks unavailable/private context", async () => {
    const f = await fixture();
    f.request.mockResolvedValueOnce({
      context: { ...context(), bankReference: "private" },
    });
    await f.controller.refresh();
    expect(f.controller.getState().status).toBe("unavailable");
    expect(await f.controller.preview("100,00")).toBe(false);
    f.cleanup();
  });
  it("writes only nonsecret request correlation before explicit preview POST", async () => {
    const f = await fixture();
    await f.controller.refresh();
    expect(await f.controller.preview("100,00")).toBe(true);
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    const stored = [...f.storage.data.values()][0];
    expect(JSON.parse(stored)).toEqual({
      version: 2,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
      previewInput: {
        requestId: "request-a",
        amountCents: 10000,
        scopeRevision: "0",
      },
    });
    expect(f.request.mock.calls.find(([, options]) => options)?.[1]).toEqual({
      method: "POST",
      body: { requestId: "request-a", amountCents: 10000, scopeRevision: "0" },
    });
    expect(f.controller.getState().request?.state).toBe("OPEN");
    f.cleanup();
  });
  it("does not preview with broken storage or an invalid amount", async () => {
    const f = await fixture();
    await f.controller.refresh();
    expect(await f.controller.preview("1.234,56")).toBe(false);
    f.storage.setItem.mockImplementation(() => {
      throw new Error("denied");
    });
    expect(await f.controller.preview("100")).toBe(false);
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.cleanup();
  });
  it("requires explicit frozen terms consent before consuming proof", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const consume = vi.fn(() => `fr1.cHJvb2Y.${"A".repeat(43)}`);
    expect(await f.controller.act("CONFIRM_NEW", consume, false)).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.cleanup();
  });
  it.each([401, 403, 409, 503])(
    "keeps correlation and uncertainty after possibly dispatched %s",
    async (status) => {
      const f = await fixture(openContext());
      await f.controller.refresh();
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) => {
        if (options) throw new ApiError(status, "RECENT_AUTH_REQUIRED");
        return native(path, options);
      });
      await f.controller.act(
        "CONFIRM_NEW",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      );
      expect(f.controller.getState().uncertain).toBe(true);
      expect(f.storage.data.size).toBe(1);
      expect(
        f.request.mock.calls.filter(([, options]) => options),
      ).toHaveLength(1);
      f.cleanup();
    },
  );
  it("does not consume or dispatch after disposal during server validation", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    const consume = vi.fn(() => `fr1.cHJvb2Y.${"A".repeat(43)}`);
    const work = f.controller.act("CONFIRM_NEW", consume, true);
    await Promise.resolve();
    f.controller.dispose();
    pending.resolve(actor);
    await work;
    expect(consume).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.owner.dispose();
  });
  it("rejects changed immutable preview before consumption", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    f.setRequest({
      ...open(),
      preview: { ...open().preview, feeCents: 251, netCents: 9749 },
    });
    const consume = vi.fn();
    expect(await f.controller.act("CONFIRM_NEW", consume, true)).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    f.cleanup();
  });
  it("keeps expired preview in recovery without authorizing NEW", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    vi.setSystemTime(start + 60000);
    const consume = vi.fn();
    expect(await f.controller.act("CONFIRM_NEW", consume, true)).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(f.controller.getState().request?.requestId).toBe("request-a");
    f.cleanup();
  });
  it("recovery preserves an existing old destination even when current eligibility is denied", async () => {
    const success = vi.spyOn(toast, "success");
    const prior = existing(open(), "UNKNOWN");
    const f = await fixture({
      ...context("2"),
      newRequestAllowed: false,
      reason: "DESTINATION_UNAVAILABLE",
      recoverableRequests: [prior],
    });
    await f.controller.refresh("request-a");
    f.setRequest(prior);
    expect(
      await f.controller.act(
        "RECOVER_EXISTING",
        () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
        true,
      ),
    ).toBe(true);
    const body = f.request.mock.calls.find(([, options]) => options)?.[1]?.body;
    expect(body).toEqual({
      action: "RECOVER_EXISTING",
      requestId: "request-a",
      reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
    });
    expect(success).toHaveBeenCalledWith(
      "Solicitação registrada. A transferência ainda não foi concluída.",
    );
    f.cleanup();
  });
  it("SSR has no password/action controls or requests", async () => {
    const f = await fixture();
    const html = renderToStaticMarkup(
      createElement(WithdrawalSetup, {
        ...f.scope,
        ports: f.ports,
        onFinancialChange: f.onFinancialChange,
      }),
    );
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<form");
    expect(f.request).not.toHaveBeenCalled();
    f.cleanup();
  });
});

describe("actual React withdrawal DOM", () => {
  it("keeps the first successful password proof across context validation with a small server clock lead", async () => {
    const f = await fixture(openContext());
    const token = `fr1.cHJvb2Y.${"A".repeat(43)}`;
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/financial-reauthentication")
        ? {
            reauthenticationToken: token,
            expiresAt: new Date(start + 300250).toISOString(),
          }
        : native(path, options),
    );
    try {
      const { node } = await mount(f);
      const input = required(
        document.querySelector<HTMLInputElement>('input[type="password"]'),
      );
      input.value = "synthetic-password";
      await act(async () =>
        required(input.closest("form")).dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(
        f.request.mock.calls.filter(([path]) =>
          path.endsWith("/financial-reauthentication"),
        ),
      ).toHaveLength(1);
      expect(f.request.mock.calls.some(([path]) => path === "/v1/me")).toBe(
        true,
      );
      await act(async () =>
        required(
          node.querySelector<HTMLInputElement>('input[type="checkbox"]'),
        ).click(),
      );
      await act(async () =>
        required(
          [...node.querySelectorAll("button")].find(
            (button) => button.textContent === "Confirmar solicitação de saque",
          ),
        ).click(),
      );
      expect(
        f.request.mock.calls.filter(
          ([path, options]) =>
            path.endsWith("/withdrawals") && options?.method === "POST",
        ),
      ).toEqual([
        [
          "/v1/sites/wedding-a/withdrawals",
          {
            method: "POST",
            body: {
              action: "CONFIRM_NEW",
              requestId: "request-a",
              reauthenticationToken: token,
            },
          },
        ],
      ]);
      expect(
        f.request.mock.calls.filter(([path]) =>
          path.endsWith("/financial-reauthentication"),
        ),
      ).toHaveLength(1);
      expect(node.innerHTML).not.toContain(token);
      expect([...f.storage.data.values()].join()).not.toContain(token);
    } finally {
      f.cleanup();
    }
  });
  it.each(["COMPLETED", "REQUESTED", "UNKNOWN"] as const)(
    "keeps %s withdrawal consultation separate from available financial actions",
    async (state) => {
      const prior = {
        ...existing(),
        withdrawal: { ...existing().withdrawal, state },
      };
      const f = await fixture({
        ...context("2"),
        newRequestAllowed: state !== "UNKNOWN",
        reason: state === "UNKNOWN" ? "UNRESOLVED_OPERATION" : null,
        recoverableRequests: [prior],
      });
      try {
        f.setRequest(prior);
        const { writeWithdrawalMarker } = await import("./withdrawalClient");
        writeWithdrawalMarker(f.storage, {
          version: 1,
          siteId: access.siteId,
          operatorUserId: access.userId,
          mode: "sandbox",
          requestId: prior.requestId,
        });
        const { node } = await mount(f);
        const buttons = () => [...node.querySelectorAll("button")];
        const consult = required(
          buttons().find(
            (button) => button.textContent === "Consultar situação",
          ),
        );
        expect(consult.disabled).toBe(false);
        if (state === "COMPLETED") {
          expect(node.textContent).toContain("Concluído pelo provedor.");
          expect(node.querySelector("#withdrawal-amount")).not.toBeNull();
          expect(
            buttons().some(
              (button) => button.textContent === "Consultar prévia do saque",
            ),
          ).toBe(true);
          expect(
            buttons().some(
              (button) => button.textContent === "Confirmar senha",
            ),
          ).toBe(false);
          expect(node.querySelector('input[type="checkbox"]')).toBeNull();
          expect(node.textContent).not.toContain(
            "Recuperar solicitação original",
          );
          expect(document.querySelector('input[type="password"]')).toBeNull();
        } else {
          expect(node.querySelector('input[type="checkbox"]')).not.toBeNull();
          expect(node.textContent).toContain("Recuperar solicitação original");
          expect(
            document.querySelector('input[type="password"]'),
          ).not.toBeNull();
        }
        const reads = f.request.mock.calls.length;
        await act(async () => consult.click());
        expect(f.request.mock.calls.length).toBeGreaterThan(reads);
        expect(
          f.request.mock.calls.every(([, options]) => !options?.method),
        ).toBe(true);
      } finally {
        f.cleanup();
      }
    },
  );
  it("requires native withdrawal terms before the confirmation form submits", async () => {
    const f = await fixture(openContext());
    try {
      const { node } = await mount(f);
      const box = node.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      expect(box?.required).toBe(true);
      expect(box?.getAttribute("aria-required")).toBe("true");
      const form = box?.closest("form");
      expect(form).toBeTruthy();
      expect(form?.checkValidity()).toBe(false);
      const before = f.request.mock.calls.length;
      await act(async () =>
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
      expect(f.request).toHaveBeenCalledTimes(before);
      expect(
        f.request.mock.calls.some(
          ([path, options]) =>
            path.endsWith("/withdrawals") && options?.method === "POST",
        ),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it.each(["FAILED", "CANCELLED"] as const)(
    "shows the actual %s stored result instead of an ongoing transfer",
    async (state) => {
      const prior = {
        ...existing(),
        withdrawal: { ...existing().withdrawal, state },
      };
      const f = await fixture({
        ...context("2"),
        recoverableRequests: [prior],
      });
      try {
        f.setRequest(prior);
        const { writeWithdrawalMarker } = await import("./withdrawalClient");
        writeWithdrawalMarker(f.storage, {
          version: 1,
          siteId: access.siteId,
          operatorUserId: access.userId,
          mode: "sandbox",
          requestId: "request-a",
        });
        const { node } = await mount(f);
        expect(node.textContent).toContain(
          state === "FAILED" ? "Saque não concluído." : "Saque cancelado.",
        );
        expect(node.textContent).not.toContain(
          "Transferência em acompanhamento",
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it("reports a rejected password through toast without inline notification blocks", async () => {
    const error = vi.spyOn(toast, "error");
    const f = await fixture(openContext());
    try {
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.endsWith("/financial-reauthentication")
          ? Promise.reject(new ApiError(403, "RECENT_AUTH_REQUIRED"))
          : native(path, options),
      );
      const { node } = await mount(f);
      const input = required(
        document.querySelector<HTMLInputElement>('input[type="password"]'),
      );
      input.value = "synthetic-wrong-password";
      await act(async () =>
        required(input.closest("form")).dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
      expect(error).toHaveBeenCalledWith(
        "Não foi possível confirmar a senha. Confira os dados e tente novamente.",
      );
      expect(node.querySelector('[role="alert"], [role="status"]')).toBeNull();
      expect(input.value).toBe("");
    } finally {
      f.cleanup();
    }
  });
  it("uses toast feedback and a busy label for an explicit failed situation read", async () => {
    const error = vi.spyOn(toast, "error");
    const f = await fixture();
    const pending = deferred<unknown>();
    try {
      const { node } = await mount(f);
      const native = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.endsWith("/context") ? pending.promise : native(path, options),
      );
      await act(async () =>
        required(
          [...node.querySelectorAll("button")].find(
            (button) => button.textContent === "Consultar situação",
          ),
        ).click(),
      );
      expect(
        [...node.querySelectorAll("button")].some(
          (button) => button.disabled && button.textContent === "Consultando…",
        ),
      ).toBe(true);
      await act(async () => {
        pending.reject(new ApiError(503, "SERVICE_UNAVAILABLE"));
      });
      expect(error).toHaveBeenCalledWith(
        "Não foi possível verificar a situação do saque. Consulte novamente.",
      );
      expect(node.querySelector('[role="alert"], [role="status"]')).toBeNull();
      expect(node.textContent).not.toContain(
        "Não foi possível verificar a situação do saque.",
      );
    } finally {
      f.cleanup();
    }
  });
  it("updates the actual DOM at quote expiry and retains explicit seal recovery", async () => {
    const f = await fixture(openContext());
    const { node } = await mount(f);
    const count = f.request.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(node.textContent).toContain("Prévia expirada");
    const confirm = required(
      [...node.querySelectorAll("button")].find(
        (value) =>
          value.textContent === "Prévia expirada — encerre a solicitação",
      ),
    );
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(
      [...node.querySelectorAll("button")].some(
        (button) => button.textContent === "Confirmar senha",
      ),
    ).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(count);
    f.cleanup();
  });
  it("explicitly seals from real password and terms controls without confirmation POST", async () => {
    const success = vi.spyOn(toast, "success");
    const changed = vi.fn();
    const f = await fixture(openContext(), changed);
    const token = `fr1.cHJvb2Y.${"A".repeat(43)}`;
    const native = required(f.request.getMockImplementation());
    const sealed: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      scopeRevision: "2",
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "2",
        requestRevision: "2",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 1n),
      },
      command: {
        requestId: "request-a",
        amountCents: 10000,
        destinationVersion: 3,
      },
      sealedAt: new Date(start).toISOString(),
    };
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/financial-reauthentication")
        ? {
            reauthenticationToken: token,
            expiresAt: new Date(start + 180000).toISOString(),
          }
        : path.endsWith("/seal")
          ? { request: sealed }
          : native(path, options),
    );
    const { node } = await mount(f);
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    input.value = "synthetic-password";
    await act(async () => {
      required(input.closest("form")).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(success).toHaveBeenCalledWith(
      "Senha confirmada. Agora confirme os termos do saque.",
    );
    expect(node.textContent).not.toContain(
      "Senha confirmada para esta finalidade",
    );
    await act(async () => {
      (
        node.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click();
    });
    await act(async () => {
      required(
        [...node.querySelectorAll("button")].find(
          (value) => value.textContent === "Encerrar solicitação sem reserva",
        ),
      ).click();
    });
    expect(node.textContent).toContain("Solicitação encerrada sem reserva.");
    expect(success).toHaveBeenCalledWith("Solicitação encerrada sem reserva.");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(f.storage.data.size).toBe(0);
    expect(
      f.request.mock.calls.filter(
        ([path, options]) => options && path.endsWith("/withdrawals"),
      ),
    ).toHaveLength(0);
    expect(
      f.request.mock.calls.find(([path]) => path.endsWith("/seal"))?.[1]?.body,
    ).toEqual({ reauthenticationToken: token });
    expect(changed).toHaveBeenCalledTimes(1);
    f.cleanup();
  });
  it("actual unmount fences a delayed proof and replacement creates a fresh holder", async () => {
    const success = vi.spyOn(toast, "success");
    const f = await fixture(openContext());
    const pending = deferred<unknown>();
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/financial-reauthentication")
        ? pending.promise
        : native(path, options),
    );
    const first = await mount(f);
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    input.value = "synthetic-password";
    await act(async () => {
      required(input.closest("form")).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      first.root.unmount();
      first.node.remove();
    });
    mounts.splice(
      mounts.findIndex((entry) => entry.root === first.root),
      1,
    );
    const second = await mount(f);
    const calls = f.request.mock.calls.length;
    await act(async () => {
      pending.resolve({
        reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
        expiresAt: new Date(start + 180000).toISOString(),
      });
    });
    expect(success).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(calls);
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(second.node.textContent).not.toContain("Senha confirmada");
    expect(
      f.request.mock.calls.filter(
        ([path, options]) => options && path.endsWith("/withdrawals"),
      ),
    ).toHaveLength(0);
    f.cleanup();
  });
  it("explicitly labels live original terms without claiming bank credit", async () => {
    const value = {
      ...open(),
      mode: "live" as const,
      preview: { ...open().preview, mode: "live" as const },
    };
    const f = await fixture({ ...openContext(value), mode: "live" });
    const { node } = await mount(f);
    expect(node.textContent).toContain("Live — valores reais");
    expect(node.textContent).toContain("Banco **** 1234");
    f.cleanup();
  });
  it("shows stored legacy terms even when original verified mask is unavailable", async () => {
    const prior = { ...existing(), preview: null };
    const f = await fixture({ ...context("2"), recoverableRequests: [prior] });
    f.setRequest(prior);
    const { writeWithdrawalMarker } = await import("./withdrawalClient");
    writeWithdrawalMarker(f.storage, {
      version: 1,
      siteId: access.siteId,
      operatorUserId: access.userId,
      mode: "sandbox",
      requestId: "request-a",
    });
    const { node } = await mount(f);
    expect(node.textContent).toContain("100,00");
    expect(node.textContent).toContain("2,50");
    expect(node.textContent).toContain("97,50");
    expect(node.textContent).toContain(
      "destino original não estão disponíveis",
    );
    expect(node.textContent).not.toContain("Banco ****");
    f.cleanup();
  });
  it("clears the real password and quarantines proof pending fresh session comparison", async () => {
    const f = await fixture(openContext());
    const response = {
      reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
      expiresAt: new Date(start + 180000).toISOString(),
    };
    const fresh = deferred<unknown>();
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/financial-reauthentication")
        ? response
        : path === "/v1/me"
          ? fresh.promise
          : native(path, options),
    );
    const { node } = await mount(f);
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    input.value = "synthetic-password";
    await act(async () => {
      required(input.closest("form")).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(input.value).toBe("");
    expect(node.textContent).not.toContain("Senha confirmada");
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      1,
    );
    await act(async () => {
      f.owner.invalidate(false);
      fresh.resolve(actor);
    });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(node.innerHTML).not.toContain(response.reauthenticationToken);
    expect([...f.storage.data.values()].join()).not.toContain(
      response.reauthenticationToken,
    );
    f.cleanup();
  });
  it("requires actual terms consent and sends one proof-only confirmation", async () => {
    const changed = vi.fn();
    const f = await fixture(openContext(), changed);
    const token = `fr1.cHJvb2Y.${"A".repeat(43)}`;
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) =>
      path.endsWith("/financial-reauthentication")
        ? {
            reauthenticationToken: token,
            expiresAt: new Date(start + 180000).toISOString(),
          }
        : native(path, options),
    );
    const { node } = await mount(f);
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    input.value = "synthetic-password";
    await act(async () => {
      required(input.closest("form")).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const button = required(
      [...node.querySelectorAll("button")].find(
        (value) => value.textContent === "Confirmar solicitação de saque",
      ),
    );
    expect(button.disabled).toBe(true);
    await act(async () => {
      (
        node.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click();
    });
    await act(async () => {
      button.click();
      button.click();
    });
    expect(
      f.request.mock.calls.filter(
        ([path, options]) => options && path.endsWith("/withdrawals"),
      ),
    ).toEqual([
      [
        "/v1/sites/wedding-a/withdrawals",
        {
          method: "POST",
          body: {
            action: "CONFIRM_NEW",
            requestId: "request-a",
            reauthenticationToken: token,
          },
        },
      ],
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(node.innerHTML).not.toContain(token);
    expect([...f.storage.data.values()].join()).not.toMatch(
      /synthetic-password|fr1\./,
    );
    f.cleanup();
  });
  it("keeps a lost action acknowledgment on actual remount and consults the same request only", async () => {
    const f = await fixture(openContext());
    await f.controller.refresh();
    const native = required(f.request.getMockImplementation());
    f.request.mockImplementation(async (path, options) => {
      if (options) throw new Error("lost acknowledgment");
      return native(path, options);
    });
    await f.controller.act(
      "CONFIRM_NEW",
      () => `fr1.cHJvb2Y.${"A".repeat(43)}`,
      true,
    );
    const postCount = f.request.mock.calls.filter(
      ([, options]) => options,
    ).length;
    const pending: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-a",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: "1",
      requestRevision: null,
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: "1",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      command: null,
    };
    f.setContext({
      ...context("1"),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
      recoverableRequests: [pending],
    });
    f.setRequest(pending);
    const { node } = await mount(f);
    expect(node.textContent).toContain(
      "Resultado em verificação. Consulte a situação.",
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(f.request.mock.calls.filter(([, options]) => options)).toHaveLength(
      postCount,
    );
    expect(
      f.request.mock.calls.some(([path]) =>
        path.endsWith("/requests/request-a"),
      ),
    ).toBe(true);
    f.cleanup();
  });
  it("StrictMode mount only discovers and never posts", async () => {
    const f = await fixture();
    const { node } = await mount(f);
    expect(node.textContent).toContain("Solicitação de saque");
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.cleanup();
  });
  it("shows exact frozen server terms and profile label with no bank-credit claim", async () => {
    const f = await fixture(openContext());
    const { node } = await mount(f);
    expect(node.textContent).toContain("100,00");
    expect(node.textContent).toContain("2,50");
    expect(node.textContent).toContain("97,50");
    expect(node.textContent).toContain("Banco **** 1234");
    expect(node.textContent).toContain("Nome no perfil");
    expect(node.textContent).not.toMatch(
      /crédito confirmado|beneficiário verificado/i,
    );
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    f.cleanup();
  });
  it("owner loss retracts password immediately and stale denial cannot revoke replacement", async () => {
    const f = await fixture(openContext());
    await mount(f);
    await act(async () => {
      f.owner.invalidate(false);
    });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(f.request.mock.calls.every(([, options]) => !options)).toBe(true);
    f.cleanup();
  });
});

describe("deliberate withdrawal discovery paging", () => {
  const revision = "90071992547409931";
  const cursor = "issued:next-page";
  function historical(
    id: string,
  ): WithdrawalRequestStatus & { state: "EXISTING" } {
    const value = existing(open(id));
    return {
      ...value,
      scopeRevision: revision,
      observationOrder: { ...value.observationOrder, scopeRevision: revision },
      withdrawal: { ...value.withdrawal, id: `intent-${id}` },
    };
  }
  function head(rows = [historical("request-a")]): WithdrawalRequestContext {
    return {
      ...context(revision),
      recoverableRequests: rows,
      nextCursor: cursor,
    };
  }
  function page(
    rows: WithdrawalRequestStatus[] = [historical("request-b")],
  ): WithdrawalRequestContext {
    return { ...head([]), recoverableRequests: rows, nextCursor: null };
  }
  async function pagingFixture(first = head(), next = page()) {
    const f = await fixture(first);
    let response: WithdrawalRequestContext = next;
    f.request.mockImplementation(async (path, options) => {
      if (path === "/v1/me") return actor;
      if (path.includes("/context?cursor=")) return { context: response };
      if (path.endsWith("/context")) return { context: first };
      if (path.includes("/requests/")) {
        const id = decodeURIComponent(path.split("/").at(-1) ?? "");
        return {
          request:
            first.openRequest?.requestId === id
              ? first.openRequest
              : historical(id),
        };
      }
      throw new Error(
        `Unexpected paging request ${path} ${options?.method ?? "GET"}`,
      );
    });
    await f.controller.refresh();
    return {
      ...f,
      first,
      next,
      setPage(value: WithdrawalRequestContext) {
        response = value;
      },
    };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);
  it("loads one explicit cursor page with native actor and fresh canonical head while preserving financial state", async () => {
    const f = await pagingFixture();
    try {
      const before = f.controller.getState();
      const calls = f.request.mock.calls.length;
      expect(await f.controller.loadMore()).toBe(true);
      const state = f.controller.getState();
      expect(state.context).toEqual(before.context);
      expect(state.request).toEqual(before.request);
      expect(state.proofRevision).toBe(before.proofRevision);
      expect(state.uncertain).toBe(before.uncertain);
      expect(state.busy).toBe(before.busy);
      expect(state.discovery.requests.map((value) => value.requestId)).toEqual([
        "request-a",
        "request-b",
      ]);
      expect(state.discovery.nextCursor).toBeNull();
      expect(f.request.mock.calls.slice(calls).map(([path]) => path)).toEqual([
        "/v1/me",
        `/v1/sites/wedding-a/withdrawals/context?cursor=${encodeURIComponent(cursor)}`,
        "/v1/sites/wedding-a/withdrawals/context",
      ]);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(f.ports.newRequestId).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.every(
          ([, options]) => !options?.method || options.method === "GET",
        ),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    ["duplicate", page([historical("request-b"), historical("request-b")])],
    ["overlap", page([historical("request-a"), historical("request-b")])],
    [
      "lexical regression",
      page([historical("request-c"), historical("request-b")]),
    ],
    ["cycle", { ...page(), nextCursor: cursor }],
    ["empty continuation", { ...page([]), nextCursor: "issued:another-page" }],
    ["foreign site", { ...page(), siteId: "wedding-b" }],
    [
      "changed revision",
      {
        ...page(),
        scopeRevision: "90071992547409932",
        observationOrder: {
          ...page().observationOrder,
          scopeRevision: "90071992547409932",
        },
      },
    ],
    [
      "older time",
      { ...page(), observedAt: new Date(start - 1).toISOString() },
    ],
    [
      "future time",
      { ...page(), observedAt: new Date(start + 1001).toISOString() },
    ],
  ])(
    "rejects a %s batch without authority, proof or partial history changes",
    async (_name, next) => {
      const f = await pagingFixture(head(), next);
      try {
        const before = f.controller.getState();
        expect(await f.controller.loadMore()).toBe(false);
        const state = f.controller.getState();
        expect(
          state.discovery.requests.map((value) => value.requestId),
        ).toEqual(["request-a"]);
        expect(state.discovery.error).not.toBe("");
        expect(state.context).toEqual(before.context);
        expect(state.request).toEqual(before.request);
        expect(state.proofRevision).toBe(before.proofRevision);
        expect(f.storage.setItem).not.toHaveBeenCalled();
        expect(f.storage.removeItem).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it("rejects a changed fresh canonical head instead of installing the page or promoting authority", async () => {
    const f = await pagingFixture();
    try {
      const original = required(f.request.getMockImplementation());
      const before = f.controller.getState();
      f.request.mockImplementation(async (path, options) =>
        path.endsWith("/context")
          ? { context: { ...f.first, nextCursor: null } }
          : original(path, options),
      );
      expect(await f.controller.loadMore()).toBe(false);
      expect(f.controller.getState().context).toEqual(before.context);
      expect(f.controller.getState().discovery.requests).toEqual(
        before.discovery.requests,
      );
      expect(f.controller.getState().proofRevision).toBe(before.proofRevision);
    } finally {
      f.cleanup();
    }
  });
  it("uses only recoverable IDs for the page boundary while an OPEN has a higher lexical ID", async () => {
    const currentOpen = {
      ...open("zzzz-open"),
      scopeRevision: revision,
      observationOrder: {
        ...open("zzzz-open").observationOrder,
        scopeRevision: revision,
      },
    };
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST" as const,
      openRequest: currentOpen,
    };
    const next = {
      ...page(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST" as const,
      openRequest: currentOpen,
    };
    const f = await pagingFixture(first, next);
    try {
      f.setRequest(currentOpen);
      expect(await f.controller.loadMore()).toBe(true);
      expect(
        f.controller
          .getState()
          .discovery.requests.map((value) => value.requestId),
      ).toEqual(["request-a", "request-b"]);
      expect(f.controller.getState().context?.openRequest?.requestId).toBe(
        "zzzz-open",
      );
    } finally {
      f.cleanup();
    }
  });
  it.each([404, 503])(
    "keeps a %s page error separate from original proof and financial state and retries only on another click",
    async (status) => {
      const f = await pagingFixture();
      try {
        const original = required(f.request.getMockImplementation());
        const before = f.controller.getState();
        f.request.mockImplementation(async (path, options) => {
          if (path.includes("?cursor="))
            throw new ApiError(status, "WITHDRAWAL_UNAVAILABLE");
          return original(path, options);
        });
        expect(await f.controller.loadMore()).toBe(false);
        expect(f.controller.getState().status).toBe(before.status);
        expect(f.controller.getState().context).toEqual(before.context);
        expect(f.controller.getState().proofRevision).toBe(
          before.proofRevision,
        );
        expect(f.controller.getState().discovery.requests).toEqual(
          before.discovery.requests,
        );
        expect(
          f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
        ).toHaveLength(1);
        f.request.mockImplementation(original);
        expect(await f.controller.loadMore()).toBe(true);
        expect(
          f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
        ).toHaveLength(2);
      } finally {
        f.cleanup();
      }
    },
  );
  it("an empty final page does not clear original correlation or infer a different eligibility", async () => {
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION" as const,
    };
    const next = {
      ...page([]),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION" as const,
    };
    const f = await pagingFixture(first, next);
    try {
      const before = f.controller.getState();
      expect(await f.controller.loadMore()).toBe(true);
      expect(f.controller.getState().discovery.requests).toEqual(
        before.discovery.requests,
      );
      expect(f.controller.getState().context?.newRequestAllowed).toBe(false);
      expect(await f.controller.preview("100")).toBe(false);
      expect(f.ports.newRequestId).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("reserves one actual page promise before callbacks and never queues repeated clicks", async () => {
    const f = await pagingFixture();
    const waiting = deferred<unknown>();
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.includes("?cursor=") ? waiting.promise : original(path, options),
      );
      const work = f.controller.loadMore();
      await flush();
      expect(f.controller.getState().discovery.status).toBe("loading");
      expect(await f.controller.loadMore()).toBe(false);
      expect(
        f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
      ).toHaveLength(1);
      waiting.resolve({ context: f.next });
      expect(await work).toBe(true);
      expect(
        f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
      ).toHaveLength(1);
    } finally {
      waiting.resolve({ context: f.next });
      f.cleanup();
    }
  });
  it.each(["owner", "request", "clock", "storage"] as const)(
    "rejects in-place %s replacement before projecting old private history",
    async (port) => {
      const f = await pagingFixture();
      const waiting = deferred<unknown>();
      try {
        const original = required(f.request.getMockImplementation());
        f.request.mockImplementation((path, options) =>
          path.includes("?cursor=") ? waiting.promise : original(path, options),
        );
        const work = f.controller.loadMore();
        await flush();
        const replacement = await fixture();
        try {
          if (port === "owner") f.ports.owner = replacement.owner;
          if (port === "request") f.ports.request = replacement.request;
          if (port === "clock") f.ports.now = () => Date.now() + 1;
          if (port === "storage") f.ports.storage = replacement.storage;
          waiting.resolve({ context: f.next });
          expect(await work).toBe(false);
          expect(f.controller.getState().discovery.requests).toEqual([]);
          expect(f.controller.getState().context).toBeNull();
          expect(replacement.request).not.toHaveBeenCalled();
        } finally {
          replacement.cleanup();
        }
      } finally {
        waiting.resolve({ context: f.next });
        f.cleanup();
      }
    },
  );
  it("never consumes an arbitrary cursor or selects an unobserved request ID", async () => {
    const f = await pagingFixture();
    try {
      const count = f.request.mock.calls.length;
      expect(await f.controller.loadMore("unissued:cursor")).toBe(false);
      expect(
        await f.controller.selectDiscoveredRequest("request-unobserved"),
      ).toBe(false);
      expect(f.request.mock.calls).toHaveLength(count);
    } finally {
      f.cleanup();
    }
  });
  it("explicitly selects the discovered original ID through canonical and exact GETs only", async () => {
    const f = await pagingFixture();
    try {
      expect(await f.controller.loadMore()).toBe(true);
      const count = f.request.mock.calls.length;
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        true,
      );
      expect(f.controller.getState().request?.requestId).toBe("request-b");
      expect(f.request.mock.calls.slice(count).map(([path]) => path)).toEqual([
        "/v1/sites/wedding-a/withdrawals/context",
        "/v1/sites/wedding-a/withdrawals/requests/request-b",
      ]);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(f.ports.newRequestId).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.every(
          ([, options]) => !options?.method || options.method === "GET",
        ),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("shows a load-more control in the real mounted setup without automatically traversing history", async () => {
    const f = await pagingFixture();
    try {
      f.controller.dispose();
      const { node } = await mount(f);
      expect(
        f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
      ).toHaveLength(0);
      const button = [...node.querySelectorAll("button")].find((value) =>
        value.textContent?.includes("Carregar mais solicitações"),
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
        await flush();
      });
      expect(
        node.querySelector('[data-request-id="request-b"]'),
      ).not.toBeNull();
      expect(
        f.request.mock.calls.filter(([path]) => path.includes("?cursor=")),
      ).toHaveLength(1);
      expect(f.storage.setItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("preserves the latest unresolved floor when selecting a different discovered ID", async () => {
    const unresolved: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-b",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: revision,
      requestRevision: "2",
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: revision,
        requestRevision: "2",
        recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n + 4n),
      },
      command: {
        requestId: "request-b",
        amountCents: 10000,
        destinationVersion: 3,
      },
    };
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION" as const,
    };
    const next = {
      ...page([unresolved]),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION" as const,
    };
    const f = await pagingFixture(first, next);
    try {
      expect(await f.controller.loadMore()).toBe(true);
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        false,
      );
      expect(f.controller.getState().request?.requestId).not.toBe("request-b");
      expect(
        f.controller
          .getState()
          .discovery.requests.find((value) => value.requestId === "request-b"),
      ).toEqual(unresolved);
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each(["immutable", "microsecond", "terminal"])(
    "restores the discovered %s floor before an exact ID lookup",
    async (kind) => {
      const originalRow = historical("request-b");
      const row =
        kind === "terminal"
          ? {
              ...originalRow,
              withdrawal: {
                ...originalRow.withdrawal,
                state: "COMPLETED" as const,
              },
            }
          : originalRow;
      const f = await pagingFixture(head(), page([row]));
      try {
        expect(await f.controller.loadMore()).toBe(true);
        const original = required(f.request.getMockImplementation());
        const changed =
          kind === "immutable"
            ? {
                ...originalRow,
                withdrawal: {
                  ...originalRow.withdrawal,
                  id: "different-intent",
                },
              }
            : kind === "microsecond"
              ? {
                  ...originalRow,
                  observationOrder: {
                    ...originalRow.observationOrder,
                    recordUpdatedAtMicroseconds: String(BigInt(start) * 1000n),
                  },
                }
              : originalRow;
        f.request.mockImplementation(async (path, options) =>
          path.endsWith("/requests/request-b")
            ? { request: changed }
            : original(path, options),
        );
        expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
          false,
        );
        expect(f.controller.getState().request?.requestId).not.toBe(
          "request-b",
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it("blocks selection over a conflicting retained unknown marker without deleting it or quarantining proof", async () => {
    const f = await pagingFixture();
    try {
      expect(await f.controller.loadMore()).toBe(true);
      f.storage.data.set(
        "entrelacos.withdrawal.v1:wedding-a:admin-a",
        JSON.stringify({
          version: 1,
          siteId: access.siteId,
          operatorUserId: actor.user.id,
          mode: "sandbox",
          requestId: "request-retained",
        }),
      );
      const before = f.controller.getState();
      const count = f.request.mock.calls.length;
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        false,
      );
      expect(f.request.mock.calls).toHaveLength(count);
      expect(f.controller.getState().proofRevision).toBe(before.proofRevision);
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each([401, 403])(
    "invalidates only the actual current owner after a %s page failure",
    async (status) => {
      const f = await pagingFixture();
      try {
        const original = required(f.request.getMockImplementation());
        f.request.mockImplementation(async (path, options) => {
          if (path.includes("?cursor="))
            throw new ApiError(status, "UNAUTHORIZED");
          return original(path, options);
        });
        expect(await f.controller.loadMore()).toBe(false);
        expect(f.owner.getSnapshot().status).not.toBe("verified");
        expect(f.controller.getState().context).toBeNull();
        expect(f.controller.getState().discovery.requests).toEqual([]);
      } finally {
        f.cleanup();
      }
    },
  );
  it("invalidates the current identity when a valid native me names another session", async () => {
    const f = await pagingFixture();
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) =>
        path === "/v1/me"
          ? { ...actor, session: { ...actor.session, id: "session-other" } }
          : original(path, options),
      );
      expect(await f.controller.loadMore()).toBe(false);
      expect(f.owner.getSnapshot().status).not.toBe("verified");
      expect(
        f.request.mock.calls.some(([path]) => path.includes("?cursor=")),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it("does not use a stale unauthorized page to invalidate a replacement owner", async () => {
    const f = await pagingFixture();
    const waiting = deferred<unknown>();
    const replacement = await fixture();
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.includes("?cursor=") ? waiting.promise : original(path, options),
      );
      const work = f.controller.loadMore();
      await flush();
      f.ports.owner = replacement.owner;
      waiting.reject(new ApiError(401, "UNAUTHORIZED"));
      expect(await work).toBe(false);
      expect(replacement.owner.getSnapshot().status).toBe("verified");
    } finally {
      f.cleanup();
      replacement.cleanup();
    }
  });
  it("keeps the unkeyed mounted pending slot until an old scope's actual read settles", async () => {
    const f = await pagingFixture();
    const replacement = await pagingFixture();
    const waiting = deferred<unknown>();
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) =>
        path.includes("?cursor=") ? waiting.promise : original(path, options),
      );
      f.controller.dispose();
      replacement.controller.dispose();
      replacement.owner.invalidate(false);
      await replacement.owner.load();
      const replacementEpoch = replacement.owner.getSnapshot().sessionEpoch;
      expect(replacementEpoch).not.toBe(f.scope.sessionEpoch);
      const { root, node } = await mount(f);
      const more = () =>
        [...node.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Carregar mais solicitações"),
        );
      await act(async () => {
        more()?.click();
        await flush();
      });
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(WithdrawalSetup, {
              ...replacement.scope,
              sessionEpoch: replacementEpoch,
              ports: replacement.ports,
            }),
          ),
        );
        await flush();
      });
      await act(async () => {
        more()?.click();
        await flush();
      });
      expect(
        replacement.request.mock.calls.some(([path]) =>
          path.includes("?cursor="),
        ),
      ).toBe(false);
      await act(async () => {
        waiting.resolve({ context: f.next });
        await flush();
      });
      expect(node.textContent).not.toContain("request-b");
      expect(
        replacement.request.mock.calls.some(([path]) =>
          path.includes("?cursor="),
        ),
      ).toBe(false);
      await act(async () => {
        more()?.click();
        await flush();
      });
      expect(
        replacement.request.mock.calls.filter(([path]) =>
          path.includes("?cursor="),
        ),
      ).toHaveLength(1);
    } finally {
      waiting.resolve({ context: f.next });
      f.cleanup();
      replacement.cleanup();
    }
  });
  it.each(["/v1/me", "?cursor=", "/withdrawals/context"])(
    "forwards a real bounded abort into default native %s reads and drains actual settlement",
    async (phase) => {
      const f = await pagingFixture();
      const waiting = deferred<Response>();
      let held = false;
      const native = vi.fn(
        async (url: RequestInfo | URL, _init?: RequestInit) => {
          const path = String(url).slice(4);
          if (
            held &&
            (phase === "/withdrawals/context"
              ? path.endsWith(phase)
              : path.includes(phase))
          )
            return waiting.promise;
          const payload =
            path === "/v1/me"
              ? actor
              : { context: path.includes("?cursor=") ? f.next : f.first };
          return new Response(JSON.stringify(payload), { status: 200 });
        },
      );
      vi.stubGlobal("fetch", native);
      f.controller.dispose();
      const ports = { owner: f.owner, storage: f.storage, now: f.ports.now };
      const controller = createWithdrawalSetupController(
        f.scope,
        () => {},
        ports,
      );
      try {
        await controller.refresh();
        held = true;
        const work = controller.loadMore();
        await flush();
        const signal = native.mock.calls.at(-1)?.[1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(45000);
        expect(signal?.aborted).toBe(true);
        const count = native.mock.calls.length;
        expect(await controller.loadMore()).toBe(false);
        expect(native.mock.calls).toHaveLength(count);
        waiting.resolve(
          new Response(
            JSON.stringify(
              phase === "/v1/me"
                ? actor
                : { context: phase === "?cursor=" ? f.next : f.first },
            ),
            { status: 200 },
          ),
        );
        expect(await work).toBe(false);
        expect(
          controller.getState().discovery.requests.map((row) => row.requestId),
        ).toEqual(["request-a"]);
      } finally {
        waiting.resolve(new Response("{}"));
        controller.dispose();
        f.cleanup();
      }
    },
  );
  it("does not dispatch after a reentrant page notification disposes the controller", async () => {
    const f = await pagingFixture();
    try {
      const count = f.request.mock.calls.length;
      f.changed.mockImplementation((state) => {
        if (state.discovery.status === "loading") f.controller.dispose();
      });
      expect(await f.controller.loadMore()).toBe(false);
      expect(f.request.mock.calls).toHaveLength(count);
    } finally {
      f.cleanup();
    }
  });
  it("preserves the original OPEN expiry timer while accepting another discovery page", async () => {
    const currentOpen = {
      ...open("zzzz-open"),
      scopeRevision: revision,
      observationOrder: {
        ...open("zzzz-open").observationOrder,
        scopeRevision: revision,
      },
    };
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST" as const,
      openRequest: currentOpen,
    };
    const f = await pagingFixture(first, {
      ...page(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST",
      openRequest: currentOpen,
    });
    try {
      const before = f.controller.getState().proofRevision;
      expect(await f.controller.loadMore()).toBe(true);
      expect(f.controller.getState().proofRevision).toBe(before);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.controller.getState().proofRevision).toBe(before + 1);
    } finally {
      f.cleanup();
    }
  });

  it("keeps the successful confirmation time as a floor for the next explicit page", async () => {
    const f = await pagingFixture();
    try {
      vi.setSystemTime(start + 20);
      const firstPage = {
        ...page(),
        observedAt: new Date(start + 10).toISOString(),
        nextCursor: "issued:last-page",
      };
      f.setPage(firstPage);
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) =>
        path.endsWith("/context")
          ? {
              context: {
                ...f.first,
                observedAt: new Date(start + 15).toISOString(),
              },
            }
          : original(path, options),
      );
      expect(await f.controller.loadMore()).toBe(true);
      f.setPage({
        ...page([historical("request-c")]),
        observedAt: new Date(start + 12).toISOString(),
      });
      expect(await f.controller.loadMore()).toBe(false);
      expect(
        f.controller.getState().discovery.requests.map((row) => row.requestId),
      ).toEqual(["request-a", "request-b"]);
    } finally {
      f.cleanup();
    }
  });
  it("rejects an OPEN observation newer than its purported fresh canonical confirmation", async () => {
    const currentOpen = {
      ...open("zzzz-open"),
      scopeRevision: revision,
      observationOrder: {
        ...open("zzzz-open").observationOrder,
        scopeRevision: revision,
      },
    };
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST" as const,
      openRequest: currentOpen,
    };
    const f = await pagingFixture(first, {
      ...page(),
      newRequestAllowed: false,
      reason: "OPEN_REQUEST",
      openRequest: {
        ...currentOpen,
        observedAt: new Date(start + 5).toISOString(),
      },
      observedAt: new Date(start + 5).toISOString(),
    });
    try {
      vi.setSystemTime(start + 10);
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) =>
        path.endsWith("/context")
          ? {
              context: {
                ...first,
                observedAt: new Date(start + 10).toISOString(),
              },
            }
          : original(path, options),
      );
      expect(await f.controller.loadMore()).toBe(false);
      expect(
        f.controller.getState().discovery.requests.map((row) => row.requestId),
      ).toEqual(["request-a"]);
    } finally {
      f.cleanup();
    }
  });
  it.each(["page", "head"])(
    "rejects a nested future observation in the %s without touching proof",
    async (phase) => {
      const f = await pagingFixture();
      try {
        const before = f.controller.getState();
        if (phase === "page")
          f.setPage(
            page([
              {
                ...historical("request-b"),
                observedAt: new Date(start + 1).toISOString(),
              },
            ]),
          );
        else {
          const original = required(f.request.getMockImplementation());
          f.request.mockImplementation(async (path, options) =>
            path.endsWith("/context")
              ? {
                  context: {
                    ...f.first,
                    recoverableRequests: [
                      {
                        ...historical("request-a"),
                        observedAt: new Date(start + 1).toISOString(),
                      },
                    ],
                  },
                }
              : original(path, options),
          );
        }
        expect(await f.controller.loadMore()).toBe(false);
        expect(f.controller.getState().proofRevision).toBe(
          before.proofRevision,
        );
        expect(f.controller.getState().discovery.requests).toEqual(
          before.discovery.requests,
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it("uses the guarded existing-only consultation from the mounted history control", async () => {
    const f = await pagingFixture();
    try {
      f.controller.dispose();
      const { node } = await mount(f);
      const button = (text: string) =>
        [...node.querySelectorAll("button")].find(
          (value) => value.textContent === text,
        );
      await act(async () => {
        button("Carregar mais solicitações")?.click();
        await flush();
      });
      const count = f.request.mock.calls.length;
      await act(async () => {
        node
          .querySelector<HTMLButtonElement>(
            '[data-request-id="request-b"] button',
          )
          ?.click();
        await flush();
      });
      expect(f.request.mock.calls.slice(count).map(([path]) => path)).toEqual([
        "/v1/sites/wedding-a/withdrawals/context",
        "/v1/sites/wedding-a/withdrawals/requests/request-b",
      ]);
      expect(node.textContent).toContain("Solicitação original registrada");
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("masks private history on mounted same-object owner replacement before another request", async () => {
    const f = await pagingFixture();
    const replacement = await pagingFixture();
    try {
      f.controller.dispose();
      const { root, node } = await mount(f);
      expect(
        node.querySelector('[data-request-id="request-a"]'),
      ).not.toBeNull();
      f.ports.owner = replacement.owner;
      const count = replacement.request.mock.calls.length;
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(WithdrawalSetup, {
              ...f.scope,
              ports: f.ports,
              onFinancialChange: f.onFinancialChange,
            }),
          ),
        );
      });
      expect(node.textContent).not.toContain("request-a");
      expect(node.textContent).toContain("Acesso financeiro restrito");
      expect(replacement.request.mock.calls).toHaveLength(count);
    } finally {
      f.cleanup();
      replacement.cleanup();
    }
  });
  it("holds the actual native JSON read after headers and timeout before permitting another page", async () => {
    const f = await pagingFixture();
    const body = deferred<unknown>();
    let held = false;
    const native = vi.fn(
      async (url: RequestInfo | URL, _init?: RequestInit) => {
        const path = String(url).slice(4);
        if (held && path.includes("?cursor="))
          return {
            ok: true,
            status: 200,
            json: () => body.promise,
          } as Response;
        return new Response(
          JSON.stringify(path === "/v1/me" ? actor : { context: f.first }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", native);
    f.controller.dispose();
    const controller = createWithdrawalSetupController(f.scope, () => {}, {
      owner: f.owner,
      storage: f.storage,
      now: f.ports.now,
    });
    try {
      await controller.refresh();
      held = true;
      const work = controller.loadMore();
      await flush();
      const signal = native.mock.calls.at(-1)?.[1]?.signal;
      await vi.advanceTimersByTimeAsync(45000);
      expect(signal?.aborted).toBe(true);
      const count = native.mock.calls.length;
      expect(await controller.loadMore()).toBe(false);
      expect(native.mock.calls).toHaveLength(count);
      body.resolve({ context: f.next });
      expect(await work).toBe(false);
      expect(
        controller.getState().discovery.requests.map((row) => row.requestId),
      ).toEqual(["request-a"]);
    } finally {
      body.resolve({ context: f.next });
      controller.dispose();
      f.cleanup();
    }
  });

  it("does not reuse an unresolved discovered ID after a later canonical page omits it", async () => {
    const unresolved: WithdrawalRequestStatus = {
      siteId: access.siteId,
      requestId: "request-b",
      mode: "sandbox",
      state: "UNRESOLVED",
      scopeRevision: revision,
      requestRevision: null,
      observedAt: new Date(start).toISOString(),
      observationOrder: {
        scopeRevision: revision,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      command: null,
    };
    const first = {
      ...head(),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION" as const,
    };
    const f = await pagingFixture(first, {
      ...page([unresolved]),
      newRequestAllowed: false,
      reason: "UNRESOLVED_OPERATION",
    });
    try {
      expect(await f.controller.loadMore()).toBe(true);
      const freshHead = context(String(BigInt(revision) + 1n));
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) =>
        path.endsWith("/context")
          ? { context: freshHead }
          : original(path, options),
      );
      await f.controller.refresh();
      f.ports.newRequestId.mockReturnValue("request-b");
      expect(await f.controller.preview("100")).toBe(false);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.some(([, options]) => options?.method === "POST"),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("explicitly restarts same-head navigation without erasing discovered identity floors", async () => {
    const f = await pagingFixture();
    try {
      expect(await f.controller.loadMore()).toBe(true);
      await f.controller.refresh();
      expect(
        f.controller.getState().discovery.requests.map((row) => row.requestId),
      ).toEqual(["request-a"]);
      expect(f.controller.getState().discovery.nextCursor).toBe(cursor);
      const originalRow = historical("request-b");
      f.setPage(
        page([
          {
            ...originalRow,
            withdrawal: { ...originalRow.withdrawal, id: "replacement-intent" },
          },
        ]),
      );
      expect(await f.controller.loadMore()).toBe(false);
      expect(
        f.controller.getState().discovery.requests.map((row) => row.requestId),
      ).toEqual(["request-a"]);
    } finally {
      f.cleanup();
    }
  });
  it("aborts a page on explicit same-head refresh but holds admission until its actual settlement", async () => {
    const f = await pagingFixture();
    const waiting = deferred<unknown>();
    let signal: AbortSignal | undefined;
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) => {
        if (path.includes("?cursor=")) {
          signal = options?.signal;
          return waiting.promise;
        }
        return original(path, options);
      });
      const work = f.controller.loadMore();
      await flush();
      await f.controller.refresh();
      expect(signal?.aborted).toBe(true);
      expect(f.controller.getState().discovery.status).toBe("ready");
      expect(await f.controller.loadMore()).toBe(false);
      waiting.resolve({ context: f.next });
      expect(await work).toBe(false);
      f.request.mockImplementation(original);
      expect(await f.controller.loadMore()).toBe(true);
    } finally {
      waiting.resolve({ context: f.next });
      f.cleanup();
    }
  });
  it.each(["owner", "request", "clock", "storage"] as const)(
    "masks old history before sibling layout effects on distinct rendered %s ports",
    async (kind) => {
      const f = await pagingFixture();
      const replacement = await pagingFixture(head([historical("request-z")]));
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      mounts.push({ root, node });
      let inspect = false;
      const beforeEffects: string[] = [];
      function Probe() {
        useLayoutEffect(() => {
          if (inspect) beforeEffects.push(node.innerHTML);
        });
        return null;
      }
      const render = (ports: typeof f.ports) =>
        createElement(
          StrictMode,
          null,
          createElement(
            "div",
            null,
            createElement(Probe, { key: "probe" }),
            createElement(WithdrawalSetup, { ...f.scope, ports, key: "setup" }),
          ),
        );
      try {
        f.controller.dispose();
        await act(async () => {
          root.render(render(f.ports));
        });
        expect(
          node.querySelector('[data-request-id="request-a"]'),
        ).not.toBeNull();
        const next = { ...f.ports };
        if (kind === "owner") next.owner = replacement.owner;
        if (kind === "request") next.request = replacement.request;
        if (kind === "clock") next.now = () => Date.now();
        if (kind === "storage") next.storage = replacement.storage;
        inspect = true;
        await act(async () => {
          root.render(render(next));
        });
        expect(beforeEffects.length).toBeGreaterThan(0);
        expect(beforeEffects[0]).not.toContain("request-a");
        expect(beforeEffects[0]).toContain("Acesso financeiro restrito");
      } finally {
        f.cleanup();
        replacement.cleanup();
      }
    },
  );
  it("resamples actual ports and owner after the final reentrant clock getter before private projection", async () => {
    const f = await pagingFixture();
    const replacement = await fixture();
    try {
      const clock = f.ports.now;
      let reads = 0;
      Object.defineProperty(f.ports, "now", {
        configurable: true,
        get() {
          if (++reads === 2) f.ports.owner = replacement.owner;
          return clock;
        },
      });
      const next = f.controller.getState();
      expect(next.context).toBeNull();
      expect(next.discovery.requests).toEqual([]);
      expect(replacement.owner.getSnapshot().status).toBe("verified");
    } finally {
      f.cleanup();
      replacement.cleanup();
    }
  });
  it.each([
    start - 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    start + 0.5,
    new Error("clock lost"),
  ])(
    "rejects a middle clock sample %s without dispatch or lowering its observation floor",
    async (sample) => {
      const f = await pagingFixture();
      let samples: (number | Error)[] = [];
      const clock = () => {
        const value = samples.shift() ?? start;
        if (value instanceof Error) throw value;
        return value;
      };
      f.controller.dispose();
      const controller = createWithdrawalSetupController(f.scope, () => {}, {
        ...f.ports,
        now: clock,
      });
      try {
        await controller.refresh();
        const count = f.request.mock.calls.length;
        samples = [start, sample, start];
        await expect(
          Promise.resolve().then(() => controller.loadMore()),
        ).resolves.toBe(false);
        expect(f.request.mock.calls).toHaveLength(count);
        expect(controller.getState().discovery.requests).toEqual([]);
      } finally {
        controller.dispose();
        f.cleanup();
      }
    },
  );
  it("does not publish an obsolete timeout after the synchronous abort listener revokes its owner", async () => {
    const f = await pagingFixture();
    const waiting = deferred<unknown>();
    try {
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation((path, options) => {
        if (!path.includes("?cursor=")) return original(path, options);
        options?.signal?.addEventListener(
          "abort",
          () => f.owner.invalidate(false),
          { once: true },
        );
        return waiting.promise;
      });
      const work = f.controller.loadMore();
      await flush();
      f.changed.mockClear();
      await vi.advanceTimersByTimeAsync(45000);
      expect(f.changed.mock.calls.map(([state]) => state.status)).toEqual([
        "denied",
      ]);
      waiting.resolve({ context: f.next });
      expect(await work).toBe(false);
    } finally {
      waiting.resolve({ context: f.next });
      f.cleanup();
    }
  });
  it.each(["reportFailure", "invalidate"] as const)(
    "captures and fences the native %s callable after its getter disposes the reader",
    async (kind) => {
      const f = await pagingFixture();
      const obsolete = vi.fn();
      try {
        const original = required(f.request.getMockImplementation());
        f.request.mockImplementation(async (path, options) => {
          if (kind === "reportFailure" && path.includes("?cursor="))
            throw new ApiError(401, "UNAUTHORIZED");
          if (kind === "invalidate" && path === "/v1/me")
            return {
              ...actor,
              session: { ...actor.session, id: "other-session" },
            };
          return original(path, options);
        });
        Object.defineProperty(f.owner, kind, {
          configurable: true,
          get() {
            f.controller.dispose();
            return obsolete;
          },
        });
        expect(await f.controller.loadMore()).toBe(false);
        expect(obsolete).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it("reserves explicit selection before a storage callback can reenter another selection", async () => {
    const f = await pagingFixture();
    let inner: Promise<boolean> | null = null;
    try {
      expect(await f.controller.loadMore()).toBe(true);
      let entered = false;
      f.storage.getItem.mockImplementation(() => {
        if (!entered) {
          entered = true;
          inner = f.controller.selectDiscoveredRequest("request-a");
        }
        return null;
      });
      const count = f.request.mock.calls.length;
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        true,
      );
      expect(await inner).toBe(false);
      expect(f.request.mock.calls.slice(count).map(([path]) => path)).toEqual([
        "/v1/sites/wedding-a/withdrawals/context",
        "/v1/sites/wedding-a/withdrawals/requests/request-b",
      ]);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each(["other", "same", "malformed", "inaccessible"])(
    "preserves a %s retained marker appearing while exact selection is pending",
    async (kind) => {
      const f = await pagingFixture();
      const waiting = deferred<unknown>();
      try {
        expect(await f.controller.loadMore()).toBe(true);
        const original = required(f.request.getMockImplementation());
        f.request.mockImplementation((path, options) =>
          path.endsWith("/requests/request-b")
            ? waiting.promise
            : original(path, options),
        );
        const work = f.controller.selectDiscoveredRequest("request-b");
        await flush();
        const key = "entrelacos.withdrawal.v1:wedding-a:admin-a";
        const retained =
          kind === "malformed"
            ? "broken-marker"
            : JSON.stringify({
                version: 1,
                siteId: access.siteId,
                operatorUserId: actor.user.id,
                mode: "sandbox",
                requestId: kind === "same" ? "request-b" : "request-original",
              });
        if (kind === "inaccessible")
          f.storage.getItem.mockImplementation(() => {
            throw new Error("unavailable storage");
          });
        else f.storage.data.set(key, retained);
        waiting.resolve({ request: historical("request-b") });
        expect(await work).toBe(false);
        expect(f.controller.getState().request?.requestId).not.toBe(
          "request-b",
        );
        if (kind !== "inaccessible")
          expect(f.storage.data.get(key)).toBe(retained);
        expect(f.storage.setItem).not.toHaveBeenCalled();
        expect(f.storage.removeItem).not.toHaveBeenCalled();
      } finally {
        waiting.resolve({ request: historical("request-b") });
        f.cleanup();
      }
    },
  );
  it("does not emit private selection after its final storage callback replaces the live owner", async () => {
    const f = await pagingFixture();
    const replacement = await fixture();
    try {
      expect(await f.controller.loadMore()).toBe(true);
      let reads = 0;
      f.storage.getItem.mockImplementation(() => {
        if (++reads === 3) f.ports.owner = replacement.owner;
        return null;
      });
      f.changed.mockClear();
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        false,
      );
      expect(
        f.changed.mock.calls.some(
          ([state]) => state.request?.requestId === "request-b",
        ),
      ).toBe(false);
      expect(replacement.owner.getSnapshot().status).toBe("verified");
    } finally {
      f.cleanup();
      replacement.cleanup();
    }
  });
  it("separates old proof validation from a new selection and preserves its fresh proof holder", async () => {
    const f = await pagingFixture();
    const waiting = deferred<unknown>();
    let unsubscribe = () => {};
    try {
      expect(await f.controller.selectDiscoveredRequest("request-a")).toBe(
        true,
      );
      expect(await f.controller.loadMore()).toBe(true);
      const original = required(f.request.getMockImplementation());
      let hold = true;
      f.request.mockImplementation((path, options) => {
        if (path === "/v1/me" && hold) {
          hold = false;
          return waiting.promise;
        }
        return original(path, options);
      });
      const old = f.controller.guard.validate();
      await flush();
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        true,
      );
      const freshHolder = vi.fn();
      unsubscribe = f.controller.guard.subscribeInvalidation(freshHolder);
      const fresh = f.controller.guard.validate();
      expect(fresh).not.toBe(old);
      await flush();
      waiting.resolve(actor);
      expect(await old).toBe(false);
      expect(await fresh).toBe(true);
      expect(freshHolder).not.toHaveBeenCalled();
      expect(f.controller.getState().request?.requestId).toBe("request-b");
    } finally {
      waiting.resolve(actor);
      unsubscribe();
      f.cleanup();
    }
  });
  it("repeats the exact marker after a stable final clock-port getter writes unrelated uncertainty", async () => {
    const f = await pagingFixture();
    const key = "entrelacos.withdrawal.v1:wedding-a:admin-a";
    const retained = JSON.stringify({
      version: 1,
      siteId: access.siteId,
      operatorUserId: actor.user.id,
      mode: "sandbox",
      requestId: "request-original",
    });
    try {
      expect(await f.controller.loadMore()).toBe(true);
      const originalGet = f.storage.getItem.getMockImplementation();
      let reads = 0;
      f.storage.getItem.mockImplementation((markerKey) => {
        reads++;
        return originalGet?.(markerKey) ?? null;
      });
      const clock = f.ports.now;
      Object.defineProperty(f.ports, "now", {
        configurable: true,
        get() {
          if (reads >= 3) f.storage.data.set(key, retained);
          return clock;
        },
      });
      f.changed.mockClear();
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        false,
      );
      expect(
        f.changed.mock.calls.some(
          ([state]) => state.request?.requestId === "request-b",
        ),
      ).toBe(false);
      expect(f.storage.data.get(key)).toBe(retained);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each([
    [9n, false],
    [11n, true],
  ])(
    "compares exact microsecond %s against the just-confirmed canonical row",
    async (exactDelta, accepted) => {
      const f = await pagingFixture();
      try {
        expect(await f.controller.loadMore()).toBe(true);
        const nextRevision = String(BigInt(revision) + 1n);
        const row = (id: string, delta: bigint) => {
          const value = historical(id);
          return {
            ...value,
            scopeRevision: nextRevision,
            observationOrder: {
              ...value.observationOrder,
              scopeRevision: nextRevision,
              recordUpdatedAtMicroseconds: String(
                BigInt(start) * 1000n + delta,
              ),
            },
          };
        };
        const confirmed = {
          ...context(nextRevision),
          recoverableRequests: [row("request-a", 1n), row("request-b", 10n)],
        };
        const original = required(f.request.getMockImplementation());
        f.request.mockImplementation(async (path, options) => {
          if (path.endsWith("/context")) return { context: confirmed };
          if (path.endsWith("/requests/request-b"))
            return { request: row("request-b", exactDelta) };
          return original(path, options);
        });
        expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
          accepted,
        );
        if (accepted)
          expect(f.controller.getState().request?.requestId).toBe("request-b");
        else
          expect(f.controller.getState().request?.requestId).not.toBe(
            "request-b",
          );
        expect(f.storage.setItem).not.toHaveBeenCalled();
        expect(f.storage.removeItem).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it("rejects a canonical OPEN that revives a known discovered existing identity", async () => {
    const f = await pagingFixture();
    try {
      expect(await f.controller.loadMore()).toBe(true);
      const nextRevision = String(BigInt(revision) + 1n);
      const oldOpen = open("request-b");
      const canonicalOpen = {
        ...oldOpen,
        scopeRevision: nextRevision,
        observationOrder: {
          ...oldOpen.observationOrder,
          scopeRevision: nextRevision,
        },
      };
      const confirmed = {
        ...context(nextRevision),
        openRequest: canonicalOpen,
        newRequestAllowed: false,
        reason: "OPEN_REQUEST" as const,
      };
      const next = {
        ...historical("request-b"),
        scopeRevision: nextRevision,
        observationOrder: {
          ...historical("request-b").observationOrder,
          scopeRevision: nextRevision,
        },
      };
      const original = required(f.request.getMockImplementation());
      f.request.mockImplementation(async (path, options) => {
        if (path.endsWith("/context")) return { context: confirmed };
        if (path.endsWith("/requests/request-b")) return { request: next };
        return original(path, options);
      });
      expect(await f.controller.selectDiscoveredRequest("request-b")).toBe(
        false,
      );
      expect(f.controller.getState().request?.requestId).not.toBe("request-b");
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
});
