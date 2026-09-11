import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRecognitionChallenge,
  panelHandoffUrl,
} from "./adminRecognition";

describe("public administrative handoff", () => {
  it("creates a random verifier and sends only its SHA-256 challenge to the panel", async () => {
    const first = await createRecognitionChallenge();
    const second = await createRecognitionChallenge();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toBe(
      createHash("sha256").update(first.verifier).digest("hex"),
    );
    const url = panelHandoffUrl(
      "https://panel.test",
      "one",
      "https://wedding.test",
      first.challenge,
    );
    expect(url).not.toContain(first.verifier);
    expect(new URL(url).searchParams.get("challenge")).toBe(first.challenge);
  });
  it("rejects unsafe panel locations", () => {
    for (const value of [
      "javascript:alert(1)",
      "https://user:pass@panel.test",
      "https://panel.test/redirect",
      "http://outside.test",
    ])
      expect(() =>
        panelHandoffUrl(value, "one", "https://wedding.test", "a".repeat(64)),
      ).toThrow();
  });
});
