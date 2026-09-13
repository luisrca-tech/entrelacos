import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readFamilyMessage, writeFamilyMessage } from "./messages";

describe("messages service validation", () => {
  it("parses the shared plain text contract before opening a transaction", async () => {
    const transaction = vi.fn();
    const db = { transaction } as never;
    await expect(
      writeFamilyMessage(
        db,
        "family-token",
        {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "<script>alert(1)</script>",
        },
        new Date("2029-01-10T12:00:00.000Z"),
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid clock without querying the database", async () => {
    const execute = vi.fn();
    const db = { execute } as never;
    await expect(
      readFamilyMessage(db, "family-token", new Date("invalid")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(execute).not.toHaveBeenCalled();
  });
});
