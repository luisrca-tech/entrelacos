import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { createReceivingSetupRepository } from "./receivingSetupRepository";

const at = new Date("2026-10-16T12:00:00.000Z");
const holder = {
  id: "holder-one",
  siteId: "site-one",
  environment: "sandbox",
  holderUserId: "bride-one",
  holderName: "Marina",
  designatedByUserId: "owner-one",
  designatedAt: at,
  consentId: "consent-one",
  consentVersion: "asaas-receiving-v1",
  consentAt: at,
  consentSessionId: "session-one",
  consentAuthenticatedAt: at,
};
function fixture(rows: Record<string, unknown>[][]) {
  const execute = vi.fn(
    async (_query: Parameters<PgDialect["sqlToQuery"]>[0]) => ({
      rows: rows.shift() ?? [],
    }),
  );
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
    work({ execute }),
  );
  const db = { execute, transaction } as unknown as Parameters<
    typeof createReceivingSetupRepository
  >[0];
  const repository = createReceivingSetupRepository(db, {
    mode: "sandbox",
    applicationEnvironment: "development",
    policyVersion: "policy-v1",
    maxAuthAgeMs: 300000,
    now: () => at,
  });
  return { execute, transaction, repository };
}
const actor = {
  userId: "bride-one",
  siteId: "site-one",
  sessionId: "session-one",
};
const recentAuth = {
  ...actor,
  proofKind: "PASSWORD_REAUTHENTICATION" as const,
  provenance: "backend" as const,
  verification: "verified" as const,
  authenticatedAt: at,
  expiresAt: new Date(at.getTime() + 300000),
};
describe("receiving holder and consent custody", () => {
  it("loads initial setup authentication from the actual current holder session timestamp", async () => {
    const createdAt = new Date(at.getTime() - 3_600_000);
    const expiresAt = new Date(createdAt.getTime() + 7 * 86400000);
    const values = fixture([
      [{ id: "site-one", isDemo: true }],
      [{ role: "SITE_ADMIN" }],
      [{ id: "session-one", createdAt, expiresAt }],
      [{ id: "membership-one" }],
      [holder],
    ]);
    const proof = await values.repository.readSessionAuthentication(actor);
    expect(proof).toMatchObject({
      ...actor,
      proofKind: "SESSION_AUTHENTICATION",
      provenance: "backend",
      verification: "verified",
      authenticatedAt: createdAt,
      expiresAt,
    });
    expect(proof.authenticatedAt).not.toEqual(at);
    expect(values.transaction).toHaveBeenCalledOnce();
  });
  it.each(["valid", "forged-time", "revoked-session"])(
    "checks actual session authority before storing consent (%s)",
    async (scenario) => {
      const createdAt = "2026-10-16T11:00:00.123456Z";
      const expiresAt = "2026-10-23T11:00:00.123456Z";
      const evidence = {
        ...actor,
        proofKind: "SESSION_AUTHENTICATION" as const,
        provenance: "backend" as const,
        verification: "verified" as const,
        authenticatedAt: readDatabaseTimestamp(
          scenario === "forged-time"
            ? "2026-10-16T11:00:00.123457Z"
            : createdAt,
        ),
        expiresAt: readDatabaseTimestamp(expiresAt),
      };
      const values = fixture([
        [{ id: "site-one", isDemo: true }],
        [{ role: "SITE_ADMIN" }],
        scenario === "revoked-session"
          ? []
          : [{ id: actor.sessionId, createdAt, expiresAt }],
        [{ id: "membership-one" }],
        [
          {
            ...holder,
            consentId: null,
            consentVersion: null,
            consentAt: null,
            consentSessionId: null,
            consentAuthenticatedAt: null,
          },
        ],
        [],
      ]);
      const consent = values.repository.consent(
        actor,
        evidence,
        "asaas-receiving-v1",
      );
      if (scenario === "valid") await expect(consent).resolves.toBeUndefined();
      else await expect(consent).rejects.toMatchObject({ status: 403 });
      const dialect = new PgDialect();
      const queries = values.execute.mock.calls.map(
        (call) => dialect.sqlToQuery(call[0]).sql,
      );
      expect(
        queries.filter((query) => query.startsWith("UPDATE")),
      ).toHaveLength(scenario === "valid" ? 1 : 0);
      if (scenario === "valid")
        expect(queries.at(-1)).toContain(
          'consent_authenticated_at=(SELECT created_at FROM "session"',
        );
    },
  );
  it("does not treat an administrator as holder without stored designation", async () => {
    const values = fixture([[]]);
    await expect(values.repository.requireHolder(actor)).rejects.toMatchObject({
      code: "RECEIVING_HOLDER_REQUIRED",
    });
  });
  it("rejects a planner with the same site role but different designated identity", async () => {
    const values = fixture([[holder]]);
    await expect(
      values.repository.requireHolder({ ...actor, userId: "planner-one" }),
    ).rejects.toMatchObject({ code: "RECEIVING_HOLDER_REQUIRED" });
  });
  it("cannot replace a stored receiving holder", async () => {
    const values = fixture([
      [{ id: "site-one", isDemo: true }],
      [{ role: "OWNER" }],
      [{ id: "session-one" }],
      [{ id: "bride-two" }],
      [holder],
    ]);
    await expect(
      values.repository.designate(
        { ...actor, userId: "owner-one" },
        "bride-two",
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_HOLDER_ALREADY_DESIGNATED" });
    expect(values.execute).toHaveBeenCalledTimes(5);
  });
  it("checks recent authentication before accepting consent", async () => {
    const values = fixture([]);
    await expect(
      values.repository.consent(
        actor,
        { ...recentAuth, userId: "planner-one" },
        "asaas-receiving-v1",
      ),
    ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(values.transaction).not.toHaveBeenCalled();
  });
  it("reads exactly the persisted holder and consent for provider provisioning", async () => {
    const values = fixture([[holder]]);
    expect(await values.repository.requireHolder(actor)).toMatchObject({
      holderUserId: "bride-one",
      consentId: "consent-one",
    });
    expect(
      JSON.stringify(
        await fixture([[holder]]).repository.readHolder("site-one"),
      ),
    ).not.toContain("cpfCnpj");
  });
  it("keeps live setup unavailable on development", () => {
    expect(() =>
      createReceivingSetupRepository({} as never, {
        mode: "live",
        applicationEnvironment: "development",
        policyVersion: "v1",
        maxAuthAgeMs: 300000,
        now: () => at,
      }),
    ).toThrow();
  });
  it.each([new Date(Number.NaN), new Date("2026-10-16T12:00:01.000Z")])(
    "rejects invalid or future recent authentication",
    async (authenticatedAt) => {
      const values = fixture([]);
      await expect(
        values.repository.consent(
          actor,
          { ...recentAuth, authenticatedAt },
          "asaas-receiving-v1",
        ),
      ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
      expect(values.transaction).not.toHaveBeenCalled();
    },
  );
  it("rechecks the same persisted consent using the actual nomination transaction", async () => {
    const values = fixture([[holder]]);
    const context = {
      actor,
      draft: { environment: "sandbox", policyVersion: "policy-v1" },
      applicationEnvironment: "development",
    } as Parameters<typeof values.repository.admission.readAuthority>[0];
    const original = await values.repository.admission.readAuthority(context);
    expect(original).toMatchObject({
      holderUserId: actor.userId,
      authorityId: holder.id,
      consentId: holder.consentId,
      consentVersion: holder.consentVersion,
    });
    const execute = vi.fn(async () => ({ rows: [holder] }));
    await expect(
      values.repository.admission.lockAuthority(
        { execute } as never,
        context,
        original,
      ),
    ).resolves.toEqual(original);
    expect(execute).toHaveBeenCalledOnce();
    expect(values.transaction).not.toHaveBeenCalled();
  });
  it("does not accept consent replaced between admission and commit", async () => {
    const values = fixture([[holder]]);
    const context = {
      actor,
      draft: { environment: "sandbox", policyVersion: "policy-v1" },
      applicationEnvironment: "development",
    } as Parameters<typeof values.repository.admission.readAuthority>[0];
    const original = await values.repository.admission.readAuthority(context);
    const execute = vi.fn(async () => ({
      rows: [{ ...holder, consentId: "other-consent" }],
    }));
    await expect(
      values.repository.admission.lockAuthority(
        { execute } as never,
        context,
        original,
      ),
    ).rejects.toThrow();
  });
  it("normalizes raw PostgreSQL holder and consent timestamps with their stored precision", async () => {
    const raw = {
      ...holder,
      designatedAt: "2026-10-16 11:59:57.123456+00",
      consentAt: "2026-10-16 08:59:59.987654-03",
      consentAuthenticatedAt: "2026-10-16 11:59:58.456789+00",
    };
    const values = fixture([[raw]]);
    const stored = await values.repository.readHolder("site-one");
    expect(stored?.designatedAt).toBeInstanceOf(Date);
    expect(stored?.consentAt).toBeInstanceOf(Date);
    expect(stored?.consentAuthenticatedAt).toBeInstanceOf(Date);
    for (const field of [
      "designatedAt",
      "consentAt",
      "consentAuthenticatedAt",
    ] as const)
      expect(databaseTimestampEpochMicroseconds(stored?.[field])).toBe(
        databaseTimestampEpochMicroseconds(raw[field]),
      );
  });
  it("retains exact null consent timestamps for a newly designated holder", async () => {
    const values = fixture([
      [
        {
          ...holder,
          designatedAt: "2026-10-16 12:00:00.000000+00",
          consentId: null,
          consentVersion: null,
          consentAt: null,
          consentSessionId: null,
          consentAuthenticatedAt: null,
        },
      ],
    ]);
    expect(await values.repository.readHolder("site-one")).toMatchObject({
      designatedAt: at,
      consentAt: null,
      consentAuthenticatedAt: null,
    });
  });
  it.each([
    ["designatedAt", "private-invalid-timestamp"],
    ["designatedAt", new Date(Number.NaN)],
    ["designatedAt", null],
    ["consentAt", "2026-02-30 12:00:00+00"],
    ["consentAt", undefined],
    ["consentAuthenticatedAt", new Date(Number.NaN)],
    ["consentAuthenticatedAt", undefined],
  ])(
    "rejects invalid stored %s without exposing database values",
    async (field, value) => {
      const values = fixture([[{ ...holder, [field as string]: value }]]);
      const error = await values.repository
        .readHolder("site-one")
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: "RECEIVING_SETUP_UNAVAILABLE",
        status: 503,
      });
      expect(String(error)).not.toContain("private-invalid-timestamp");
    },
  );
});
