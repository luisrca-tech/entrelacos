import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPublicSiteMessage, listSiteMessages } from "./messages";

describe("public message service validation", () => {
  it("validates author and message before opening a database transaction", async () => {
    const transaction = vi.fn();
    const db = { transaction } as never;

    await expect(
      createPublicSiteMessage(
        db,
        "site-1",
        {
          requestId: randomUUID(),
          authorName: "  ",
          text: "Com carinho",
        },
        "a".repeat(64),
        new Date("2029-01-10T12:00:00.000Z"),
      ),
    ).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid clock without querying the database", async () => {
    const execute = vi.fn();
    const db = { execute } as never;

    await expect(
      createPublicSiteMessage(
        db,
        "site-1",
        {
          requestId: randomUUID(),
          authorName: "Ana Silva",
          text: "Com carinho",
        },
        "a".repeat(64),
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });

    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a continuation cursor for the same normalized author search", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ id: "site-1", lifecycle: "ACTIVE", mural_enabled: true }],
    });
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { execute, select } as never;
    const cursor = Buffer.from(
      JSON.stringify({
        scope: "site-messages",
        siteId: "site-1",
        createdAt: "2029-01-10T12:00:00.000Z",
        id: "message-1",
        search: "jose",
      }),
      "utf8",
    ).toString("base64url");

    await expect(
      listSiteMessages(db, { userId: "owner-1", role: "OWNER" }, "site-1", {
        search: "JOSÉ",
        cursor,
      }),
    ).resolves.toEqual({ messages: [], nextCursor: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
