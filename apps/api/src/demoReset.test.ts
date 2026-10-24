import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { assertDemoResetAllowed, resetDemoSite } from "./demoReset";

describe("real showcase reset protection", () => {
  it("blocks the opted-in showcase after locking its site and before any deletion", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ id: "demo-wedding", is_demo: true }],
    }));
    const remove = vi.fn();
    const transaction = vi.fn(async (work: (tx: unknown) => unknown) =>
      work({ execute, delete: remove }),
    );
    await expect(
      resetDemoSite(
        { transaction } as never,
        { userId: "owner-one", role: "OWNER" },
        "demo-wedding",
        { liveDemoSiteId: "demo-wedding" },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "DEMO_REAL_ACTIVITY_PROTECTED",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it.each(["holder", "account"])(
    "protects persisted live %s custody after removing the opt-in flag",
    async (kind) => {
      const execute = vi.fn(
        async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const text = new PgDialect().sqlToQuery(query).sql;
          if (text.includes("to_regclass"))
            return { rows: [{ holders: true, accounts: true }] };
          return {
            rows: [
              {
                present: text.includes(
                  kind === "holder"
                    ? "receiving_setup_holder"
                    : "receiving_account",
                ),
              },
            ],
          };
        },
      );
      await expect(
        assertDemoResetAllowed({ execute } as never, "demo-wedding"),
      ).rejects.toMatchObject({ code: "DEMO_REAL_ACTIVITY_PROTECTED" });
    },
  );
  it("keeps old schemas without financial tables reset-compatible without querying absent relations", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ holders: false, accounts: false }],
    }));
    await expect(
      assertDemoResetAllowed({ execute } as never, "demo-wedding"),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });
});
