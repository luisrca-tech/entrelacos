import { afterEach, describe, expect, it, vi } from "vitest";
import { createR2GiftMediaStorage } from "./giftMediaStorage";

afterEach(() => vi.unstubAllGlobals());
describe("derivative storage has no raw browser signing capability", () => {
  it("constructs SDK locally and resolves canonical URL without network or presigning", async () => {
    const network = vi.fn(() => {
      throw new Error("Real network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const value = createR2GiftMediaStorage({
      accountId: "a".repeat(32),
      accessKeyId: "LOCAL_TEST_KEY",
      secretAccessKey: "LOCAL_TEST_SECRET",
      bucketName: "existing-gifts",
      publicOrigin: "https://media.example.test",
    });
    try {
      expect(value.storageNamespace).toBe("existing-gifts");
      expect(
        value.getDerivativeUrl("gifts/wedding-a/asset-a/processing-a.webp"),
      ).toBe(
        "https://media.example.test/gifts/wedding-a/asset-a/processing-a.webp",
      );
      for (const name of ["signUpload", "headStaging", "readStaging"])
        expect(value).not.toHaveProperty(name);
      expect(network).not.toHaveBeenCalled();
    } finally {
      if ("close" in value) await value.close();
    }
  });
});
