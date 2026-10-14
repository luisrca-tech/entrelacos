// @vitest-environment jsdom
import { createHmac, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { URL as NodeURL } from "node:url";
import {
  type MeResponse,
  type ReceivingNominationContext,
  receivingNominationInputSchema,
  type SiteAccess,
} from "@entrelacos/contracts";
import { act, createElement, StrictMode } from "react";
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
import { ApiError, apiRequest } from "../lib/apiClient";
import { createFinancialReauthenticationController } from "./financialReauthenticationClient";
import { createPanelActorOwner } from "./panelActor";
import {
  createReceivingSetupController,
  mountReceivingSetupController,
  ReceivingSetup,
  ReceivingSetupView,
} from "./ReceivingSetup";
import { createReceivingNominationController } from "./receivingNominationClient";

// Resolve the API's installed driver without adding a browser dependency.
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
  membershipId: "membership-a",
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
const available: ReceivingNominationContext = {
  state: "AVAILABLE",
  siteId: "wedding-a",
  requestId: "server-request-a",
  policyVersion: "server-policy-a",
  mode: "sandbox",
};
const nomination = {
  siteId: "wedding-a",
  requestId: "server-request-a",
  state: "AWAITING_PROVIDER_VERIFICATION" as const,
  createdAt: "2026-10-12T18:00:00.000Z",
  mode: "sandbox" as const,
};
const pending: ReceivingNominationContext = {
  ...available,
  state: "PENDING",
  currentPolicyVersion: "server-policy-a",
  postAllowed: true,
  nomination,
};
const proof = {
  reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
  expiresAt: "2026-10-12T18:03:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const mounts: Array<{
  root: Root;
  container: HTMLDivElement;
  active: boolean;
}> = [];
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(async () => {
  for (const bridge of httpBridges.splice(0)) await bridge.cleanup();
  await act(async () => {
    for (const entry of mounts) {
      if (entry.active) entry.root.unmount();
      entry.container.remove();
    }
  });
  mounts.length = 0;
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function receivingHttpBridge(
  policyVersion = "bridge-policy-a",
  initial?: {
    accounts: Record<string, unknown>[];
    operations: Record<string, unknown>[];
  },
) {
  vi.stubGlobal("crypto", webcrypto);
  const origin = "https://admin.example.test";
  const secret = "fictional-mounted-native-auth-secret-only-32";
  const token = "fictional-mounted-session-token";
  const storedSession = {
    id: "session-a",
    userId: "admin-a",
    token,
    createdAt: new Date(start - 60000),
    updatedAt: new Date(start),
    lastActiveAt: new Date(start),
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
    updatedAt: new Date(start),
  };
  const state = {
    currentSession: true,
    revoked: false,
    origin,
    cookie: "",
    activity: 0,
    commitLost: false,
    membershipRole: "SITE_ADMIN",
    readGate: null as ReturnType<typeof deferred<boolean>> | null,
  };
  const tables: {
    accounts: Record<string, unknown>[];
    operations: Record<string, unknown>[];
    counters: Record<string, unknown>[];
  } = { accounts: [], operations: [], counters: [] };
  if (initial) {
    tables.accounts = structuredClone(initial.accounts);
    tables.operations = structuredClone(initial.operations);
  }
  const nativeGates = new Set<ReturnType<typeof deferred<boolean>>>();
  let credential = "";
  let before: typeof tables | null = null;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const unknownQueries: string[] = [];
  const query: BridgeQuery = async (statement, params = []) => {
    const sql = typeof statement === "string" ? statement : statement.text;
    queries.push({ sql, params });
    if (/^begin/i.test(sql)) {
      before = structuredClone(tables);
      return { rows: [] };
    }
    if (/^commit/i.test(sql)) {
      before = null;
      if (state.commitLost && tables.operations.length) {
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
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/SELECT clock_timestamp/.test(sql))
      return { rows: [{ currentTime: new Date(Date.now()) }] };
    if (/^select .*from "session" inner join "user"/i.test(sql)) {
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
    }
    if (/^update "session"/i.test(sql)) {
      expect(params[2]).toBe(storedSession.id);
      storedSession.lastActiveAt = new Date(String(params[0]));
      state.activity++;
      return { rows: [] };
    }
    if (/FROM "site" st/.test(sql))
      return {
        rows:
          params[0] === access.siteId
            ? [
                {
                  siteId: access.siteId,
                  isDemo: false,
                  currentTime: new Date(Date.now()),
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
    if (/FROM "user" u/.test(sql) && /FOR SHARE OF u/.test(sql))
      return {
        rows:
          params[0] === storedUser.id
            ? [
                {
                  userId: storedUser.id,
                  role: storedUser.role,
                  state: storedUser.state,
                },
              ]
            : [],
      };
    if (/FROM "site_membership" m/.test(sql))
      return {
        rows:
          !state.revoked &&
          params.includes(storedUser.id) &&
          params.includes(access.siteId)
            ? [{ id: access.membershipId }]
            : [],
      };
    if (/FROM "user" u/.test(sql)) {
      const selected =
        params.length === 1
          ? params[0] === storedUser.id
          : params[0] === access.siteId &&
            params[1] === storedUser.id &&
            params[2] === storedUser.role;
      return {
        rows:
          selected && storedUser.state === "ACTIVE" && !state.revoked
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
    if (/INNER JOIN "user" u ON u.id = a.user_id/.test(sql))
      return {
        rows:
          params[0] === storedUser.id && storedUser.state === "ACTIVE"
            ? [{ password: credential }]
            : [],
      };
    if (/FROM "verification" v/.test(sql))
      return { rows: tables.counters.filter((row) => row.id === params[0]) };
    if (/INSERT INTO "verification"/.test(sql)) {
      const row = {
        id: params[0],
        identifier: params[1],
        value: params[2],
        expiresAt: params[3],
      };
      const index = tables.counters.findIndex((value) => value.id === row.id);
      if (index < 0) tables.counters.push(row);
      else tables.counters[index] = row;
      return { rows: [{ id: row.id }] };
    }
    if (/FULL OUTER JOIN "financial_operation" op/.test(sql)) {
      const accounts = tables.accounts.filter(
        (row) => row.siteId === params[0] && row.environment === params[1],
      );
      const operations = tables.operations.filter(
        (row) => row.siteId === params[2] && row.environment === params[3],
      );
      const joined: Array<{
        a: Record<string, unknown> | null;
        op: Record<string, unknown> | null;
      }> = [];
      for (const a of accounts) {
        const matching = operations.filter(
          (op) =>
            op.accountId === a.id &&
            op.siteId === a.siteId &&
            op.environment === a.environment,
        );
        if (!matching.length) joined.push({ a, op: null });
        for (const op of matching) joined.push({ a, op });
      }
      for (const op of operations)
        if (!accounts.some((a) => a.id === op.accountId))
          joined.push({ a: null, op });
      const projection = sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(/,\s*(?=[a-z]+\.)/);
      return {
        rows: joined.slice(0, 2).map((source) =>
          Object.fromEntries(
            projection.map((part) => {
              if (part.trim().endsWith('AS "hasProviderBinding"'))
                return [
                  "hasProviderBinding",
                  source.a === null
                    ? null
                    : [
                        "operatorReference",
                        "webhookTokenHash",
                        "accountReference",
                        "recipientReference",
                        "credentialVersion",
                        "credentialKeyId",
                        "credentialNonce",
                        "credentialCiphertext",
                        "credentialTag",
                        "observedAt",
                      ].some((key) => source.a?.[key] !== null) ||
                      source.a.providerAccountState !== "UNVERIFIED" ||
                      source.a.receivingCapability !== false ||
                      source.a.withdrawalCapability !== false ||
                      source.a.commercialEnabled !== false,
                ];
              const field = part
                .trim()
                .match(/^(a|op)\.([a-z_]+) AS "([^"]+)"$/);
              if (!field) throw new Error("Unsupported nomination projection");
              return [
                field[3],
                source[field[1] as "a" | "op"]?.[
                  field[2].replace(/_([a-z])/g, (_, c: string) =>
                    c.toUpperCase(),
                  )
                ] ?? null,
              ];
            }),
          ),
        ),
      };
    }
    if (/FROM "receiving_account" a/.test(sql))
      return {
        rows: tables.accounts
          .filter(
            (row) => row.siteId === params[0] && row.environment === params[1],
          )
          .map((row) => ({
            ...row,
            hasProviderBinding:
              row.accountReference !== null ||
              row.providerAccountState !== "UNVERIFIED",
          })),
      };
    if (/FROM "financial_operation" op/.test(sql))
      return {
        rows: tables.operations
          .filter(
            (row) =>
              row.siteId === params[0] &&
              row.requestId === params[1] &&
              row.kind === "ACCOUNT_CREATE",
          )
          .flatMap((row) => {
            const account = tables.accounts.find(
              (a) =>
                a.id === row.accountId &&
                a.siteId === row.siteId &&
                a.environment === row.environment,
            );
            return account
              ? [
                  {
                    ...row,
                    accountOperatorUserId: account.operatorUserId,
                    accountSiteId: account.siteId,
                    accountEnvironment: account.environment,
                    accountProvider: account.provider,
                  },
                ]
              : [];
          }),
      };
    const insert = sql.match(
      /^insert into "(receiving_account|financial_operation)" \((.*?)\) values \((.*?)\)/i,
    );
    if (insert) {
      const columns = [...insert[2].matchAll(/"([a-z_]+)"/g)].map((value) =>
        value[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      );
      const values = insert[3].split(",").map((value) => {
        const position = value.trim().match(/^\$(\d+)$/);
        return position ? params[Number(position[1]) - 1] : null;
      });
      const row = Object.fromEntries(
        columns.map((column, index) => [
          column,
          column === "requestSnapshot" && typeof values[index] === "string"
            ? JSON.parse(values[index] as string)
            : values[index],
        ]),
      );
      (insert[1] === "receiving_account"
        ? tables.accounts
        : tables.operations
      ).push(row);
      return {
        rows:
          typeof statement !== "string" && statement.rowMode === "array"
            ? [[row.id]]
            : [{ id: row.id }],
      };
    }
    unknownQueries.push(sql);
    throw new Error("Unsupported receiving bridge query");
  };
  const db = bridgeDrizzle({ query });
  const auth = createAuth({
    db,
    secret,
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  });
  const native = await auth.$context;
  credential = await native.password.hash("fictional-password");
  vi.spyOn(native.internalAdapter, "findSession").mockImplementation(
    async (selected) =>
      selected === token
        ? ({
            session: structuredClone(storedSession),
            user: structuredClone(storedUser),
          } as never)
        : null,
  );
  state.cookie = `${native.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
  const builder = authModule.createSessionReadAuth;
  let readAuth!: ReturnType<typeof createAuth>;
  const capture = vi
    .spyOn(authModule, "createSessionReadAuth")
    .mockImplementation((options) => {
      readAuth = builder(options);
      return readAuth;
    });
  const clock = () => new Date(Date.now());
  const repository = createReceivingNominationRepository(db, {
    mode: "sandbox",
    applicationEnvironment: "test",
    maxAuthAgeMs: 300000,
    now: clock,
  });
  const ports = createReceivingNominationComposition({
    standardAuth: auth,
    authentication: {
      db,
      secret,
      baseURL: "https://api.example.test",
      adminOrigin: origin,
    },
    configuration: {
      mode: "sandbox",
      applicationEnvironment: "test",
      policyVersion,
      requestIdentityVersion: "nr1",
    },
    nomination: {
      repository,
      loadSite: async (siteId) =>
        siteId === access.siteId ? { siteId, isDemo: false } : null,
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
    async (selected) => {
      const gate = state.readGate;
      state.readGate = null;
      if (gate) {
        nativeGates.add(gate);
        try {
          if (!(await gate.promise)) return null;
        } finally {
          nativeGates.delete(gate);
        }
      }
      return selected === token
        ? ({
            session: structuredClone(storedSession),
            user: structuredClone(storedUser),
          } as never)
        : null;
    },
  );
  const readDelete = vi.spyOn(readNative.internalAdapter, "deleteSession");
  const app = createApp(
    { auth, db, adminOrigin: origin, ...ports },
    { sink: () => {} },
  );
  const pending = new Set<Promise<unknown>>();
  const responses: Array<{
    path: string;
    method: string;
    status: number;
    cookie: string | null;
  }> = [];
  const request = vi.fn(
    async (path: string, options?: { method?: string; body?: unknown }) => {
      const work = apiRequest(path, options, (async (input, init) => {
        const relative = String(input);
        expect(relative.startsWith("/api/v1/")).toBe(true);
        const response = await app.request(
          new Request(`https://api.example.test${relative.slice(4)}`, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              Origin: state.origin,
              Cookie: state.cookie,
            },
          }),
        );
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
    },
  );
  const owner = createPanelActorOwner({
    request: () => request("/v1/me"),
    now: () => Date.now(),
  });
  await owner.load();
  const snapshot = owner.getSnapshot();
  expect(snapshot.actor?.session.id).toBe(storedSession.id);
  const scope = {
    siteId: access.siteId,
    access: snapshot.actor?.memberships?.[0] ?? null,
    sessionEpoch: snapshot.sessionEpoch,
  };
  expect(scope.access).toEqual(access);
  const container = document.createElement("div");
  document.body.append(container);
  const entry = { root: createRoot(container), container, active: true };
  mounts.push(entry);
  const render = async (nextScope = scope) =>
    act(async () =>
      entry.root.render(
        createElement(
          StrictMode,
          null,
          createElement(ReceivingSetup, {
            ...nextScope,
            ports: { request, owner, now: () => Date.now() },
          }),
        ),
      ),
    );
  const cleanup = async () => {
    state.readGate?.resolve(false);
    for (const gate of nativeGates) gate.resolve(false);
    await act(async () => {
      if (entry.active) {
        entry.root.unmount();
        entry.active = false;
      }
    });
    await Promise.allSettled([...pending]);
    owner.dispose();
    expect(pending.size).toBe(0);
    expect(unknownQueries).toEqual([]);
    expect(readDelete).not.toHaveBeenCalled();
  };
  const settle = async () =>
    act(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    });
  httpBridges.push({ cleanup });
  await render();
  await settle();
  return {
    app,
    request,
    owner,
    state,
    storedSession,
    storedUser,
    queries,
    responses,
    container,
    render,
    pending,
    tables,
    ports,
    settle,
    scope,
  };
}

describe("receiving setup mounted consumer through actual private HTTP", () => {
  it("loads a canonical nomination context through signed native auth and leaves the financial GET read-only", async () => {
    const f = await receivingHttpBridge();
    expect(f.responses).toContainEqual(
      expect.objectContaining({
        path: "/v1/sites/wedding-a/receiving/nomination-context",
        method: "GET",
        status: 200,
        cookie: null,
      }),
    );
    expect(f.container.querySelector('input[name="password"]')).not.toBeNull();
    expect(f.state.activity).toBe(1);
  });
  it("reserves one original account and operation from mounted password/proof and explicit nomination", async () => {
    const f = await receivingHttpBridge();
    await submitPassword(f.container);
    await f.settle();
    expect(f.responses).toContainEqual(
      expect.objectContaining({
        path: "/v1/sites/wedding-a/financial-reauthentication",
        method: "POST",
        status: 200,
      }),
    );
    await confirmNomination(f.container);
    await f.settle();
    expect(f.tables.accounts).toHaveLength(1);
    expect(f.tables.operations).toHaveLength(1);
    expect(f.tables.operations[0]).toMatchObject({
      kind: "ACCOUNT_CREATE",
      state: "REQUESTED",
      accountId: f.tables.accounts[0].id,
    });
    expect(f.container.textContent).toContain(
      "Verificação do provedor pendente",
    );
    expect(f.container.querySelector('input[name="password"]')).toBeNull();
    const body = f.request.mock.calls.find(
      ([path, options]) =>
        path.endsWith("/receiving/nomination") && options?.method === "POST",
    )?.[1]?.body;
    expect(body).toBeDefined();
    const original = structuredClone(f.tables);
    await expect(
      f.request("/v1/sites/wedding-a/receiving/nomination", {
        method: "POST",
        body,
      }),
    ).resolves.toMatchObject({
      nomination: { requestId: f.tables.operations[0].requestId },
    });
    expect(f.tables.accounts).toEqual(original.accounts);
    expect(f.tables.operations).toEqual(original.operations);
    const originalToken = (body as { reauthenticationToken: string })
      .reauthenticationToken;
    await expect(
      f.request("/v1/sites/wedding-a/receiving/nomination", {
        method: "POST",
        body: {
          ...(body as object),
          reauthenticationToken:
            originalToken.slice(0, -1) +
            (originalToken.endsWith("A") ? "B" : "A"),
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.tables.accounts).toEqual(original.accounts);
    expect(f.container.innerHTML).not.toContain("fr1.");
    expect(f.container.innerHTML).not.toContain("fictional-password");
  });
  it.each([
    "cookie",
    "signature",
    "unknown",
    "origin",
    "currentSession",
    "disabled",
    "revoked",
    "assistant",
    "owner",
    "foreignSite",
  ] as const)(
    "denies actual %s authority without business or financial-GET effects",
    async (kind) => {
      const f = await receivingHttpBridge();
      const activity = f.state.activity;
      if (kind === "cookie") f.state.cookie = "";
      if (kind === "signature")
        f.state.cookie = f.state.cookie.replace(/.$/, "X");
      if (kind === "unknown") {
        const unknown = "signed-but-not-stored";
        f.state.cookie = `${f.state.cookie.split("=")[0]}=${encodeURIComponent(`${unknown}.${createHmac("sha256", "fictional-mounted-native-auth-secret-only-32").update(unknown).digest("base64")}`)}`;
      }
      if (kind === "origin") f.state.origin = "https://foreign.example.test";
      if (kind === "currentSession") f.state.currentSession = false;
      if (kind === "disabled") f.storedUser.state = "DISABLED";
      if (kind === "revoked") f.state.revoked = true;
      if (kind === "assistant") {
        f.state.membershipRole = "SITE_ASSISTANT";
        f.storedUser.role = "SITE_ASSISTANT";
      }
      if (kind === "owner") f.storedUser.role = "OWNER";
      const path = `/v1/sites/${kind === "foreignSite" ? "foreign-site" : access.siteId}/receiving/nomination-context`;
      await expect(f.request(path)).rejects.toMatchObject({
        status: [
          "origin",
          "revoked",
          "assistant",
          "owner",
          "foreignSite",
        ].includes(kind)
          ? 403
          : 401,
      });
      expect(f.state.activity).toBe(activity);
      expect(f.tables).toEqual({ accounts: [], operations: [], counters: [] });
      expect(f.responses.at(-1)?.cookie).toBeNull();
      if (kind !== "foreignSite") {
        await submitPassword(f.container);
        await f.settle();
        expect(f.container.querySelector('input[name="password"]')).toBeNull();
      }
    },
  );
  it("uses the real password verifier and native rate counter before issuing any proof", async () => {
    const f = await receivingHttpBridge();
    const post = (password: string) =>
      f.request("/v1/sites/wedding-a/financial-reauthentication", {
        method: "POST",
        body: { action: "CONFIGURE_RECEIVING", password },
      });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(post("wrong-fictional-password")).rejects.toMatchObject({
        status: 403,
      });
    await expect(post("fictional-password")).rejects.toMatchObject({
      status: 429,
    });
    expect(JSON.parse(String(f.tables.counters[0].value)).attempts).toBe(3);
    expect(f.tables.accounts).toHaveLength(0);
    expect(f.container.innerHTML).not.toContain("fr1.");
  });
  it("keeps a lost committed nomination and explicitly consults its original pending identity without another POST", async () => {
    const f = await receivingHttpBridge();
    await submitPassword(f.container);
    await f.settle();
    f.state.commitLost = true;
    await confirmNomination(f.container);
    await f.settle();
    expect(f.tables.accounts).toHaveLength(1);
    expect(f.tables.operations).toHaveLength(1);
    const original = structuredClone(f.tables.operations[0]);
    const button = [...f.container.querySelectorAll("button")].find(
      (value) => value.textContent === "Verificar situação",
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    await f.settle();
    expect(f.container.textContent).toContain(
      "Verificação do provedor pendente",
    );
    expect(f.container.querySelector('input[name="password"]')).toBeNull();
    expect(f.tables.operations[0]).toEqual(original);
    expect(
      f.request.mock.calls.filter(
        ([path, options]) =>
          path.endsWith("/receiving/nomination") && options?.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("drains an actual native read and prevents its late unauthorized result from invalidating a replacement owner", async () => {
    const f = await receivingHttpBridge();
    const gate = deferred<boolean>();
    f.state.readGate = gate;
    const old = f.request("/v1/sites/wedding-a/receiving/nomination-context");
    const controller = createReceivingSetupController(
      {
        siteId: access.siteId,
        access,
        sessionEpoch: f.owner.getSnapshot().sessionEpoch,
      },
      vi.fn(),
      { owner: f.owner, request: () => old },
    );
    const load = controller.refresh();
    await act(async () => {
      f.storedSession.id = "replacement-session";
      await f.owner.load();
    });
    const replacement = f.owner.getSnapshot();
    expect(f.pending.size).toBe(1);
    controller.dispose();
    expect(f.pending.size).toBe(1);
    gate.resolve(false);
    await act(async () => {
      await load;
      await old.catch(() => {});
    });
    expect(f.pending.size).toBe(0);
    expect(f.owner.getSnapshot()).toBe(replacement);
    await f.render({ ...f.scope, sessionEpoch: replacement.sessionEpoch });
    await f.settle();
    expect(f.container.querySelector('input[name="password"]')).not.toBeNull();
  });
  it("mounts the original pending nomination under changed policy and rejects conflicting replay", async () => {
    const original = await receivingHttpBridge();
    await submitPassword(original.container);
    await original.settle();
    await confirmNomination(original.container);
    await original.settle();
    const body = original.request.mock.calls.find(
      ([path, options]) =>
        path.endsWith("/receiving/nomination") && options?.method === "POST",
    )?.[1]?.body;
    const f = await receivingHttpBridge("bridge-policy-b", original.tables);
    expect(f.container.querySelector('input[name="password"]')).toBeNull();
    expect(f.container.textContent).toContain("bridge-policy-a");
    await expect(
      f.request("/v1/sites/wedding-a/receiving/nomination-context"),
    ).resolves.toMatchObject({
      context: {
        state: "PENDING",
        requestId: original.tables.operations[0].requestId,
        policyVersion: "bridge-policy-a",
        currentPolicyVersion: "bridge-policy-b",
        postAllowed: false,
      },
    });
    await expect(
      f.request("/v1/sites/wedding-a/receiving/nomination", {
        method: "POST",
        body,
      }),
    ).rejects.toMatchObject({ status: 400, code: "NOMINATION_INVALID" });
    await expect(
      f.request("/v1/sites/wedding-a/receiving/nomination", {
        method: "POST",
        body: { ...(body as object), policyVersion: "bridge-policy-b" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    expect(f.tables.accounts).toEqual(original.tables.accounts);
    expect(f.tables.operations).toEqual(original.tables.operations);
  });
  it.each(["purpose", "expiry", "session"] as const)(
    "rejects actual %s proof without reserving a nomination",
    async (kind) => {
      const f = await receivingHttpBridge();
      const issued = (await f.request(
        "/v1/sites/wedding-a/financial-reauthentication",
        {
          method: "POST",
          body: {
            action:
              kind === "purpose" ? "REQUEST_WITHDRAWAL" : "CONFIGURE_RECEIVING",
            password: "fictional-password",
          },
        },
      )) as { reauthenticationToken: string };
      const result = (await f.request(
        "/v1/sites/wedding-a/receiving/nomination-context",
      )) as { context: ReceivingNominationContext };
      if (kind === "expiry") vi.setSystemTime(start + 300000);
      if (kind === "session") f.storedSession.id = "new-current-session";
      await expect(
        f.request("/v1/sites/wedding-a/receiving/nomination", {
          method: "POST",
          body: {
            requestId: result.context.requestId,
            policyVersion: result.context.policyVersion,
            confirmSelfAsRecipient: true,
            reauthenticationToken: issued.reauthenticationToken,
          },
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.tables.accounts).toHaveLength(0);
      expect(f.tables.operations).toHaveLength(0);
    },
  );
});
async function fixture(context: unknown = available) {
  const identity = vi.fn().mockResolvedValue(actor);
  const owner = createPanelActorOwner({
    request: identity,
    now: () => Date.now(),
  });
  await owner.load();
  const scope = {
    siteId: "wedding-a",
    access,
    sessionEpoch: owner.getSnapshot().sessionEpoch,
  };
  const request = vi.fn<
    (
      path: string,
      options?: { method: string; body: unknown },
    ) => Promise<unknown>
  >(async (path: string) => (path === "/v1/me" ? actor : { context }));
  const changed = vi.fn();
  const controller = createReceivingSetupController(scope, changed, {
    request,
    owner,
    now: () => Date.now(),
  });
  return {
    controller,
    owner,
    identity,
    scope,
    request,
    changed,
    cleanup() {
      controller.dispose();
      owner.dispose();
    },
  };
}
describe("receiving setup source ownership and quarantine", () => {
  it("loads only current strict server context and uses its original identity", async () => {
    const f = await fixture();
    await f.controller.refresh();
    expect(f.request.mock.calls).toEqual([
      ["/v1/sites/wedding-a/receiving/nomination-context"],
    ]);
    expect(f.controller.getState()).toMatchObject({
      status: "ready",
      context: available,
      uncertain: false,
    });
    expect(f.controller.guard.isCurrent()).toBe(true);
    f.cleanup();
  });
  it.each([
    pending,
    { ...pending, currentPolicyVersion: "policy-b", postAllowed: false },
  ])(
    "keeps PENDING original identity and blocks validation/POST %j",
    async (context) => {
      const f = await fixture(context);
      await f.controller.refresh();
      expect(f.controller.getState().context).toEqual(context);
      expect(f.controller.guard.isCurrent()).toBe(false);
      expect(await f.controller.guard.validate()).toBe(false);
      expect(f.request).toHaveBeenCalledTimes(1);
      f.cleanup();
    },
  );
  it("compares strict current me and retained context without refreshing the owner", async () => {
    const f = await fixture();
    await f.controller.refresh();
    const snapshot = f.owner.getSnapshot();
    expect(await f.controller.guard.validate()).toBe(true);
    expect(f.owner.getSnapshot()).toBe(snapshot);
    expect(f.identity).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.slice(1)).toEqual([
      ["/v1/me"],
      ["/v1/sites/wedding-a/receiving/nomination-context"],
    ]);
    f.cleanup();
  });
  it.each(["requestId", "policyVersion", "mode"] as const)(
    "refuses replacing the retained %s during an explicit refresh",
    async (field) => {
      const f = await fixture();
      await f.controller.refresh();
      f.request.mockResolvedValueOnce({
        context: {
          ...available,
          [field]: field === "mode" ? "live" : "replacement",
        },
      });
      await f.controller.refresh();
      expect(f.controller.getState().status).toBe("unavailable");
      expect(f.controller.guard.isCurrent()).toBe(false);
      f.request.mockResolvedValueOnce({ context: available });
      await f.controller.refresh();
      expect(f.controller.getState().context?.requestId).toBe(
        available.requestId,
      );
      f.cleanup();
    },
  );
  it.each([
    { ...actor, session: { ...actor.session, id: "new-session" } },
    {
      ...actor,
      memberships: [
        {
          ...access,
          capabilities: { ...access.capabilities, configureReceiving: false },
        },
      ],
    },
    {
      ...actor,
      session: { ...actor.session, expiresAt: "2026-10-12T17:00:00.000Z" },
    },
  ])(
    "denies changed/expired server identity before reading context %j",
    async (fresh) => {
      const f = await fixture();
      await f.controller.refresh();
      f.request.mockResolvedValueOnce(fresh);
      expect(await f.controller.guard.validate()).toBe(false);
      expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
      expect(f.request).toHaveBeenCalledTimes(2);
      f.cleanup();
    },
  );
  it("does not let an obsolete context401 invalidate a newer session", async () => {
    const f = await fixture();
    const read = deferred<unknown>();
    f.request.mockReturnValueOnce(read.promise);
    const work = f.controller.refresh();
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.owner.invalidate(false);
    await f.owner.load();
    const current = f.owner.getSnapshot();
    read.reject(new ApiError(401, "UNAUTHORIZED"));
    await work;
    expect(f.owner.getSnapshot()).toBe(current);
    expect(f.controller.getState().status).not.toBe("ready");
    f.cleanup();
  });
  it("does not let an old validation restore a guard after a newer explicit refresh", async () => {
    const f = await fixture();
    await f.controller.refresh();
    const me = deferred<unknown>();
    f.request.mockReturnValueOnce(me.promise);
    const validation = f.controller.guard.validate();
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledTimes(2);
    await f.controller.refresh();
    me.resolve(actor);
    expect(await validation).toBe(false);
    expect(f.controller.getState().context).toEqual(available);
    f.cleanup();
  });
  it("quarantines password proof through fresh me/context, then revalidates before its one-shot POST", async () => {
    const f = await fixture();
    await f.controller.refresh();
    const passwordRequest = vi.fn().mockResolvedValue(proof);
    const password = createFinancialReauthenticationController(
      { ...f.scope, action: "CONFIGURE_RECEIVING" },
      vi.fn(),
      { request: passwordRequest, now: () => start, guard: f.controller.guard },
    );
    await password.submit("fictional-password");
    expect(password.getState().status).toBe("verified");
    const request = vi.fn().mockResolvedValue({ nomination });
    const nominal = createReceivingNominationController(
      {
        ...f.scope,
        requestId: available.requestId,
        policyVersion: available.policyVersion,
      },
      vi.fn(),
      { request, guard: f.controller.guard },
    );
    await nominal.submit(true, {
      scope: { ...f.scope, action: "CONFIGURE_RECEIVING" },
      consumeProof: () => password.consumeProof(),
    });
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/sites/wedding-a/receiving/nomination-context",
      "/v1/me",
      "/v1/sites/wedding-a/receiving/nomination-context",
      "/v1/me",
      "/v1/sites/wedding-a/receiving/nomination-context",
    ]);
    expect(request).toHaveBeenCalledWith(
      "/v1/sites/wedding-a/receiving/nomination",
      {
        method: "POST",
        body: {
          requestId: available.requestId,
          policyVersion: available.policyVersion,
          confirmSelfAsRecipient: true,
          reauthenticationToken: proof.reauthenticationToken,
        },
      },
    );
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain(
      proof.reauthenticationToken,
    );
    nominal.dispose();
    password.dispose();
    f.cleanup();
  });
  it("clears quarantine synchronously on owner uncertainty and ignores a late valid comparison", async () => {
    const f = await fixture();
    await f.controller.refresh();
    const me = deferred<unknown>();
    f.request.mockReturnValueOnce(me.promise);
    const password = createFinancialReauthenticationController(
      { ...f.scope, action: "CONFIGURE_RECEIVING" },
      vi.fn(),
      {
        request: vi.fn().mockResolvedValue(proof),
        now: () => start,
        guard: f.controller.guard,
      },
    );
    const work = password.submit("fictional-password");
    await Promise.resolve();
    await Promise.resolve();
    f.owner.invalidate(false);
    expect(password.consumeProof()).toBeNull();
    me.resolve(actor);
    await work;
    expect(password.getState().status).toBe("denied");
    password.dispose();
    f.cleanup();
  });
  it("resolves server PENDING during revalidation before proof consumption", async () => {
    const f = await fixture();
    await f.controller.refresh();
    const password = createFinancialReauthenticationController(
      { ...f.scope, action: "CONFIGURE_RECEIVING" },
      vi.fn(),
      {
        request: vi.fn().mockResolvedValue(proof),
        now: () => start,
        guard: f.controller.guard,
      },
    );
    await password.submit("fictional-password");
    f.request
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce({ context: pending });
    const source = {
      scope: { ...f.scope, action: "CONFIGURE_RECEIVING" as const },
      consumeProof: vi.fn(() => password.consumeProof()),
    };
    const request = vi.fn();
    const nominal = createReceivingNominationController(
      {
        ...f.scope,
        requestId: available.requestId,
        policyVersion: available.policyVersion,
      },
      vi.fn(),
      { request, guard: f.controller.guard },
    );
    await nominal.submit(true, source);
    expect(source.consumeProof).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(password.consumeProof()).toBeNull();
    expect(f.controller.getState().context).toEqual(pending);
    nominal.dispose();
    password.dispose();
    f.cleanup();
  });
  it("preserves uncertainty and the original request through local context failure/retry", async () => {
    const f = await fixture();
    await f.controller.refresh();
    f.controller.observeNominationState({ status: "unknown", uncertain: true });
    f.request.mockRejectedValueOnce(new Error("offline"));
    await f.controller.refresh();
    expect(f.controller.getState()).toMatchObject({
      status: "unavailable",
      uncertain: true,
    });
    await f.controller.refresh();
    expect(f.controller.getState()).toMatchObject({
      context: available,
      uncertain: true,
    });
    f.cleanup();
  });
  it("creates independent lifecycle instances for StrictMode and ignores obsolete cleanup", async () => {
    const f = await fixture();
    const holder = {
      current: null as ReturnType<typeof createReceivingSetupController> | null,
    };
    const first = mountReceivingSetupController(holder, f.scope, vi.fn(), {
      request: f.request,
      owner: f.owner,
      now: () => start,
    });
    first();
    const second = mountReceivingSetupController(holder, f.scope, vi.fn(), {
      request: f.request,
      owner: f.owner,
      now: () => start,
    });
    const current = holder.current;
    first();
    expect(holder.current).toBe(current);
    await current?.refresh();
    expect(current?.getState().status).toBe("ready");
    second();
    f.cleanup();
  });
  it("renders SSR without a context request or financial form", () => {
    const request = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ReceivingSetup, {
        siteId: "wedding-a",
        access,
        sessionEpoch: null,
        ports: { request },
      }),
    );
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain("Confirmar minha indicação");
    expect(request).not.toHaveBeenCalled();
  });
  it("shows pending original policy and blocks its changed-policy action truthfully", () => {
    const context = {
      ...pending,
      currentPolicyVersion: "policy-b",
      postAllowed: false,
    };
    const html = renderToStaticMarkup(
      createElement(ReceivingSetupView, {
        scope: { siteId: "wedding-a", access, sessionEpoch: 1 },
        state: { status: "ready", context, uncertain: false },
        ready: true,
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain("Verificação do provedor pendente");
    expect(html).toContain("server-policy-a");
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain("Confirmar minha indicação");
  });
});

async function mountedFixture(
  context: ReceivingNominationContext = available,
  beforeMount?: (candidate: Awaited<ReturnType<typeof fixture>>) => void,
) {
  const f = await fixture(context);
  let serverContext = context;
  f.request.mockImplementation(async (path, options) => {
    if (path === "/v1/me" && !options) return actor;
    if (path.endsWith("/nomination-context") && !options)
      return { context: serverContext };
    if (
      path.endsWith("/financial-reauthentication") &&
      options?.method === "POST"
    )
      return proof;
    if (path.endsWith("/receiving/nomination") && options?.method === "POST") {
      serverContext = pending;
      return { nomination };
    }
    throw new Error("Unexpected synthetic request");
  });
  beforeMount?.(f);
  const container = document.createElement("div");
  document.body.append(container);
  const entry = { root: createRoot(container), container, active: true };
  mounts.push(entry);
  const render = async (scope = f.scope) => {
    await act(async () => {
      entry.root.render(
        createElement(
          StrictMode,
          null,
          createElement(ReceivingSetup, {
            ...scope,
            ports: {
              request: f.request,
              owner: f.owner,
              now: () => Date.now(),
            },
          }),
        ),
      );
    });
  };
  await render();
  return {
    ...f,
    container,
    entry,
    render,
    setContext(value: ReceivingNominationContext) {
      serverContext = value;
    },
  };
}
async function submitPassword(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    'input[name="password"]',
  );
  if (!input) throw new Error("Expected mounted password field");
  const form = input.closest("form");
  if (!form) throw new Error("Expected password form");
  await act(async () => {
    input.value = "fictional-password";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(input.value).toBe("");
  return input;
}
async function confirmNomination(container: HTMLElement) {
  const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error("Expected explicit self-confirmation");
  await act(async () => checkbox.click());
  const form = container.querySelector<HTMLFormElement>(
    'form[action$="/receiving/nomination"]',
  );
  if (!form) throw new Error("Expected nomination form");
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}
function posts(
  request: Awaited<ReturnType<typeof fixture>>["request"],
  suffix: string,
) {
  return request.mock.calls.filter(
    ([path, options]) => path.endsWith(suffix) && options?.method === "POST",
  );
}
describe("receiving setup actual React DOM with injected transport", () => {
  it("retains uncertainty and original binding after an explicit AVAILABLE retry, requiring fresh proof for replay", async () => {
    const f = await mountedFixture();
    let attempts = 0;
    let registered = false;
    let passwords = 0;
    f.request.mockImplementation(async (path, options) => {
      if (path === "/v1/me") return actor;
      if (path.endsWith("/nomination-context"))
        return { context: registered ? pending : available };
      if (path.endsWith("/financial-reauthentication"))
        return passwords++ === 0
          ? proof
          : {
              ...proof,
              reauthenticationToken: `fr1.cHJvb2Y.${"B".repeat(42)}A`,
            };
      if (path.endsWith("/receiving/nomination") && options) {
        if (++attempts === 1) throw new Error("Unknown acknowledgment");
        registered = true;
        return { nomination };
      }
      throw new Error("Unexpected synthetic request");
    });
    await submitPassword(f.container);
    await confirmNomination(f.container);
    expect(f.container.textContent).toContain(
      "Não foi possível verificar o resultado",
    );
    const first = posts(f.request, "/receiving/nomination")[0]?.[1]?.body;
    const retry = [...f.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Verificar situação",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(f.container.textContent).toContain("resultado anterior");
    expect(f.container.querySelector('input[name="password"]')).not.toBeNull();
    await confirmNomination(f.container);
    expect(posts(f.request, "/receiving/nomination")).toHaveLength(1);
    expect(f.container.textContent).toContain("Confirme sua senha novamente");
    await submitPassword(f.container);
    await confirmNomination(f.container);
    expect(posts(f.request, "/receiving/nomination")).toHaveLength(2);
    const firstInput = receivingNominationInputSchema.parse(first);
    const secondInput = receivingNominationInputSchema.parse(
      posts(f.request, "/receiving/nomination")[1]?.[1]?.body,
    );
    expect({ ...secondInput, reauthenticationToken: null }).toEqual({
      ...firstInput,
      reauthenticationToken: null,
    });
    expect(secondInput.reauthenticationToken).not.toBe(
      firstInput.reauthenticationToken,
    );
    expect(posts(f.request, "/financial-reauthentication")).toHaveLength(2);
    expect(f.container.textContent).toContain(
      "Verificação do provedor pendente",
    );
    f.cleanup();
  });
  it("mounts guarded AVAILABLE forms through StrictMode without background reads", async () => {
    const f = await mountedFixture();
    expect(f.container.querySelector('input[name="password"]')).not.toBeNull();
    expect(f.container.textContent).toContain("Confirmar minha indicação");
    const reads = f.request.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(f.request).toHaveBeenCalledTimes(reads);
    expect(posts(f.request, "/nomination")).toHaveLength(0);
    f.cleanup();
  });
  it("keeps unavailable context locked without a password or POST", async () => {
    const f = await mountedFixture(available, (candidate) =>
      candidate.request.mockRejectedValueOnce(
        new ApiError(503, "RECEIVING_NOMINATION_UNAVAILABLE"),
      ),
    );
    expect(f.container.textContent).toContain(
      "Não foi possível verificar o contexto",
    );
    expect(f.container.querySelector('input[name="password"]')).toBeNull();
    expect(posts(f.request, "/nomination")).toHaveLength(0);
    expect(posts(f.request, "/financial-reauthentication")).toHaveLength(0);
    f.cleanup();
  });
  it("clears the password immediately and keeps returned proof quarantined until fresh comparison", async () => {
    const f = await mountedFixture();
    const me = deferred<unknown>();
    f.request.mockImplementation(async (path, options) => {
      if (path === "/v1/me") return me.promise;
      if (options?.method === "POST") return proof;
      return { context: available };
    });
    await submitPassword(f.container);
    expect(f.container.textContent).toContain("Confirmando sua senha");
    expect(f.container.textContent).not.toContain(
      "Senha confirmada para esta finalidade",
    );
    expect(f.container.innerHTML).not.toContain(proof.reauthenticationToken);
    expect(f.container.innerHTML).not.toContain("fictional-password");
    await act(async () => me.resolve(actor));
    expect(f.container.textContent).toContain(
      "Senha confirmada para esta finalidade",
    );
    expect(posts(f.request, "/nomination")).toHaveLength(0);
    f.cleanup();
  });
  it("requires explicit self-confirmation and posts the retained server identity exactly once", async () => {
    const f = await mountedFixture();
    await submitPassword(f.container);
    const button = [
      ...f.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((entry) => entry.textContent === "Confirmar minha indicação");
    expect(button?.disabled).toBe(true);
    await confirmNomination(f.container);
    expect(posts(f.request, "/receiving/nomination")).toHaveLength(1);
    expect(posts(f.request, "/receiving/nomination")[0]?.[1]?.body).toEqual({
      requestId: available.requestId,
      policyVersion: available.policyVersion,
      confirmSelfAsRecipient: true,
      reauthenticationToken: proof.reauthenticationToken,
    });
    expect(f.container.textContent).toContain(
      "Verificação do provedor pendente",
    );
    expect(f.container.querySelector('input[name="password"]')).toBeNull();
    expect(f.container.innerHTML).not.toContain(proof.reauthenticationToken);
    f.cleanup();
  });
  it("rejects a proof that expires while its fresh comparison is pending", async () => {
    const f = await mountedFixture();
    const me = deferred<unknown>();
    f.request.mockImplementation(async (path, options) =>
      path === "/v1/me" ? me.promise : options ? proof : { context: available },
    );
    await submitPassword(f.container);
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    await act(async () => me.resolve(actor));
    expect(f.container.textContent).toContain(
      "Esta confirmação não está mais válida",
    );
    expect(f.container.textContent).not.toContain(
      "Senha confirmada para esta finalidade",
    );
    await confirmNomination(f.container);
    expect(posts(f.request, "/nomination")).toHaveLength(0);
    f.cleanup();
  });
  it.each([true, false])(
    "renders original PENDING policy without any password or POST when postAllowed=%s",
    async (postAllowed) => {
      const context: ReceivingNominationContext = {
        ...pending,
        currentPolicyVersion: postAllowed
          ? pending.policyVersion
          : "changed-policy",
        postAllowed,
      };
      const f = await mountedFixture(context);
      expect(f.container.textContent).toContain(
        "Verificação do provedor pendente",
      );
      expect(f.container.textContent).toContain(available.policyVersion);
      expect(f.container.querySelector('input[name="password"]')).toBeNull();
      expect(f.container.textContent).not.toContain(
        "Confirmar minha indicação",
      );
      if (!postAllowed)
        expect(f.container.textContent).toContain(
          "uma nova confirmação está bloqueada",
        );
      const retry = [...f.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Verificar situação",
      );
      await act(async () => retry?.click());
      expect(posts(f.request, "/nomination")).toHaveLength(0);
      expect(posts(f.request, "/financial-reauthentication")).toHaveLength(0);
      f.cleanup();
    },
  );
  it.each(["resolve", "reject"])(
    "ignores obsolete quarantine %s after owner replacement and actual rerender",
    async (settlement) => {
      const f = await mountedFixture();
      const me = deferred<unknown>();
      f.request.mockImplementation(async (path, options) =>
        path === "/v1/me"
          ? me.promise
          : options
            ? proof
            : { context: available },
      );
      await submitPassword(f.container);
      await act(async () => {
        f.owner.invalidate(false);
        await f.owner.load();
      });
      const current = f.owner.getSnapshot();
      await f.render({ ...f.scope, sessionEpoch: current.sessionEpoch });
      await act(async () => {
        if (settlement === "resolve") me.resolve(actor);
        else me.reject(new ApiError(401, "UNAUTHORIZED"));
      });
      expect(f.owner.getSnapshot()).toBe(current);
      expect(
        f.container.querySelector<HTMLInputElement>('input[name="password"]')
          ?.value,
      ).toBe("");
      expect(f.container.textContent).not.toContain(
        "Senha confirmada para esta finalidade",
      );
      expect(posts(f.request, "/nomination")).toHaveLength(0);
      f.cleanup();
    },
  );
  it("discards proof on actual unmount and cannot restore it in a fresh mounted form", async () => {
    const f = await mountedFixture();
    const me = deferred<unknown>();
    f.request.mockImplementation(async (path, options) =>
      path === "/v1/me" ? me.promise : options ? proof : { context: available },
    );
    await submitPassword(f.container);
    await act(async () => {
      f.entry.root.unmount();
      f.entry.active = false;
    });
    const next = {
      root: createRoot(f.container),
      container: f.container,
      active: true,
    };
    mounts.push(next);
    await act(async () => {
      next.root.render(
        createElement(ReceivingSetup, {
          ...f.scope,
          ports: { request: f.request, owner: f.owner, now: () => start },
        }),
      );
    });
    await act(async () => me.resolve(actor));
    expect(f.container.textContent).not.toContain(
      "Senha confirmada para esta finalidade",
    );
    expect(
      f.container.querySelector<HTMLInputElement>('input[name="password"]')
        ?.value,
    ).toBe("");
    expect(posts(f.request, "/nomination")).toHaveLength(0);
    f.cleanup();
  });
  it.each([
    { ...actor, session: { ...actor.session, id: "foreign-session" } },
    {
      ...actor,
      memberships: [
        {
          ...access,
          capabilities: { ...access.capabilities, configureReceiving: false },
        },
      ],
    },
  ])(
    "retracts actual mounted controls on fresh session/membership mismatch %j",
    async (fresh) => {
      const f = await mountedFixture();
      f.request.mockImplementation(async (path, options) =>
        path === "/v1/me" ? fresh : options ? proof : { context: available },
      );
      await submitPassword(f.container);
      expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
      expect(f.container.querySelector('input[name="password"]')).toBeNull();
      expect(f.container.textContent).not.toContain(
        "Senha confirmada para esta finalidade",
      );
      expect(posts(f.request, "/nomination")).toHaveLength(0);
      f.cleanup();
    },
  );
  it("uses authoritative PENDING after a real React remount without creating a replacement operation", async () => {
    const f = await mountedFixture();
    await submitPassword(f.container);
    await confirmNomination(f.container);
    const original = posts(f.request, "/receiving/nomination")[0]?.[1]?.body;
    await act(async () => {
      f.entry.root.unmount();
      f.entry.active = false;
    });
    const next = {
      root: createRoot(f.container),
      container: f.container,
      active: true,
    };
    mounts.push(next);
    await act(async () =>
      next.root.render(
        createElement(ReceivingSetup, {
          ...f.scope,
          ports: { request: f.request, owner: f.owner, now: () => start },
        }),
      ),
    );
    expect(f.container.textContent).toContain(
      "Verificação do provedor pendente",
    );
    expect(posts(f.request, "/receiving/nomination")).toHaveLength(1);
    expect(posts(f.request, "/receiving/nomination")[0]?.[1]?.body).toEqual(
      original,
    );
    f.cleanup();
  });
});
