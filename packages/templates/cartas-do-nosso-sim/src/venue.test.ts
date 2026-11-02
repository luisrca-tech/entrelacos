import { describe, expect, it, vi } from "vitest";
import { type ClipboardWriter, copyAddress } from "./venue";

describe("venue copy enhancement", () => {
  it("copies the complete selectable address and reports success", async () => {
    const writeText = vi.fn<ClipboardWriter["writeText"]>().mockResolvedValue();
    await expect(copyAddress("Av. Central, 10", { writeText })).resolves.toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith("Av. Central, 10");
  });

  it("reports failure without hiding the no-script address fallback", async () => {
    const writeText = vi
      .fn<ClipboardWriter["writeText"]>()
      .mockRejectedValue(new Error("blocked"));
    await expect(copyAddress("Av. Central, 10", { writeText })).resolves.toBe(
      false,
    );
    await expect(copyAddress("Av. Central, 10", undefined)).resolves.toBe(
      false,
    );
  });
});
