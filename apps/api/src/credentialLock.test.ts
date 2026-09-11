import { describe, expect, it, vi } from "vitest";
import {
  normalizeCredentialEmail,
  withCredentialAdvisoryLock,
} from "./credentialLock";

describe("credential advisory lock", () => {
  it("runs the protected callback under a normalized credential lock", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
      ),
    } as never;

    await expect(
      withCredentialAdvisoryLock(
        db,
        " Owner@Example.Test ",
        async () => "done",
      ),
    ).resolves.toBe("done");
    expect(execute).toHaveBeenCalledOnce();
    expect(normalizeCredentialEmail(" Owner@Example.Test ")).toBe(
      "owner@example.test",
    );
  });

  it("propagates protected operation failures to the transaction", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
      ),
    } as never;

    await expect(
      withCredentialAdvisoryLock(db, "owner@example.test", async () => {
        throw new Error("protected failure");
      }),
    ).rejects.toThrow("protected failure");
    expect(execute).toHaveBeenCalledOnce();
  });
});
