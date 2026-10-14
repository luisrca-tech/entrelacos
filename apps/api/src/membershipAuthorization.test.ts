import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { rotateInvitationAccessPin } from "./invitations";
import { readMuralConfiguration, updateMuralConfiguration } from "./messages";
import { readInvitationReport } from "./reports";
import { readRsvpDeadline, updateRsvpDeadline } from "./rsvp";

const actor = { userId: "helper-a", role: "SITE_ASSISTANT" as const };
const dialect = new PgDialect();

describe("existing operational membership SQL guards", () => {
  it("rejects an invitation mutation when its account is disabled while waiting for the site lock", async () => {
    let disabled = false;
    const row = {
      user_id: "helper-a",
      account_role: "SITE_ASSISTANT",
      account_state: "ACTIVE",
      site_id: "wedding-a",
      membership_id: "member-a",
      membership_user_id: "helper-a",
      membership_role: "SITE_ASSISTANT",
      revoked_at: null,
    };
    const execute = vi.fn(async (value: SQL) => {
      const query = dialect.sqlToQuery(value);
      if (query.sql.includes("SELECT id, manual_pin_seed"))
        return {
          rows: [{ id: "invitation-a", manual_pin_seed: "a".repeat(64) }],
        };
      if (
        query.sql.includes("FOR UPDATE") &&
        !query.sql.includes('FROM "user"')
      ) {
        disabled = true;
        return { rows: [{ id: "wedding-a" }] };
      }
      return {
        rows: [{ ...row, account_state: disabled ? "DISABLED" : "ACTIVE" }],
      };
    });
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    const query = {
      limit: vi
        .fn()
        .mockResolvedValue([{ id: "wedding-a", lifecycle: "ACTIVE" }]),
    };
    const chain = { where: vi.fn(() => query), innerJoin: vi.fn() };
    chain.innerJoin.mockReturnValue(chain);
    const tx = {
      execute,
      update,
      select: vi.fn(() => ({ from: vi.fn(() => chain) })),
    };
    const db = {
      transaction: vi.fn(async (run: (db: unknown) => Promise<unknown>) =>
        run(tx),
      ),
    };
    await expect(
      rotateInvitationAccessPin(
        db as never,
        actor,
        "wedding-a",
        "invitation-a",
        "test-only-pin-secret".repeat(2),
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(update).not.toHaveBeenCalled();
  });
  it.each([
    [
      "mural mutation",
      (db: never) =>
        updateMuralConfiguration(db, actor, "wedding-a", { enabled: false }),
    ],
    [
      "RSVP mutation",
      (db: never) =>
        updateRsvpDeadline(db, actor, "wedding-a", {
          deadlineAt: null,
          deadlineTimezone: null,
        }),
    ],
  ] as const)(
    "%s obtains its site lock before re-reading membership",
    async (_name, operation) => {
      const execute = vi.fn().mockResolvedValue({ rows: [] });
      const update = vi.fn();
      const db = {
        transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
          run({ execute, update }),
        ),
      };
      await expect(operation(db as never)).rejects.toMatchObject({
        status: 404,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      const lock = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
      const authorization = dialect.sqlToQuery(execute.mock.calls[1][0] as SQL);
      expect(lock.sql).toMatch(
        /SELECT id FROM site WHERE id = \$1 FOR UPDATE/i,
      );
      expect(lock.params).toEqual(["wedding-a"]);
      expect(authorization.sql).toMatch(/sm\.revoked_at IS NULL/i);
      expect(update).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["mural", (db: never) => readMuralConfiguration(db, actor, "wedding-a")],
    ["RSVP", (db: never) => readRsvpDeadline(db, actor, "wedding-a")],
    [
      "invitation report",
      (db: never) =>
        readInvitationReport(db, actor, "wedding-a", {
          requestId: "f4217d1d-bcae-4ac1-a67b-fabc195b7b86",
        }),
    ],
  ] as const)(
    "%s rechecks revocation, stored role and the requested site",
    async (_name, operation) => {
      const execute = vi.fn().mockResolvedValue({ rows: [] });
      const db = {
        execute,
        transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
          run({ execute }),
        ),
      };
      await expect(operation(db as never)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
      const query = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
      expect(query.sql).toMatch(/sm\.revoked_at IS NULL/i);
      expect(query.sql).toMatch(
        /sm\.role IN \('SITE_ADMIN', 'SITE_ASSISTANT'\)/i,
      );
      expect(query.sql).toMatch(/u\.role = \$/i);
      expect(query.params).toContain("wedding-a");
      expect(query.params).toContain("helper-a");
      expect(query.params).toContain("SITE_ASSISTANT");
    },
  );
});
