import { describe, expect, it } from "vitest";
import { messagesQuery } from "./messageSearch";

describe("public message search query", () => {
  it("sends a trimmed author search and retains it on later pages", () => {
    expect(messagesQuery("  Luís Silva  ")).toBe(
      "limit=20&search=Lu%C3%ADs+Silva",
    );
    expect(messagesQuery("  Luís Silva  ", "cursor / 2")).toBe(
      "limit=20&search=Lu%C3%ADs+Silva&cursor=cursor+%2F+2",
    );
  });

  it("omits an empty search while keeping pagination", () => {
    expect(messagesQuery("   ", "cursor-2")).toBe("limit=20&cursor=cursor-2");
  });
});
