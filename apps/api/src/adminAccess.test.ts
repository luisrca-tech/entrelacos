import { describe, expect, it, vi } from "vitest";
import {
  AdminAccessRejectedError,
  consumeAdminAccess,
  issueAdminAccess,
} from "./adminAccess";

describe("administrative access core validation", () => {
  it("rejects malformed user identifiers before opening a transaction", async () => {
    const db = { transaction: vi.fn() };
    await expect(
      issueAdminAccess(db as never, {
        userId: "not valid",
        purpose: "ACTIVATION",
      }),
    ).rejects.toBeInstanceOf(AdminAccessRejectedError);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed or short public credentials before opening a transaction", async () => {
    const db = { transaction: vi.fn() };
    await expect(
      consumeAdminAccess(db as never, {
        token: "short",
        password: "a secure password",
        purpose: "ACTIVATION",
      }),
    ).rejects.toBeInstanceOf(AdminAccessRejectedError);
    await expect(
      consumeAdminAccess(db as never, {
        token: "a".repeat(43),
        password: "too-short",
        purpose: "ACTIVATION",
      }),
    ).rejects.toBeInstanceOf(AdminAccessRejectedError);
    await expect(
      consumeAdminAccess(db as never, {
        token: "a".repeat(43),
        password: "too-long-pass",
        purpose: "ACTIVATION",
      }),
    ).rejects.toBeInstanceOf(AdminAccessRejectedError);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
