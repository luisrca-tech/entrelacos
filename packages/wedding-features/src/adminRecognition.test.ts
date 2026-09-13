import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminRecognition } from "./AdminRecognition";
import {
  createRecognitionChallenge,
  getAdminRecognitionView,
  panelHandoffUrl,
  runAdminHandoffOnce,
} from "./adminRecognition";

describe("public administrative handoff", () => {
  it("keeps the public SSR output empty before recognition", () => {
    expect(
      renderToStaticMarkup(
        createElement(AdminRecognition, {
          siteId: "one",
          apiOrigin: "https://api.example.test",
          panelOrigin: "https://panel.example.test",
        }),
      ),
    ).toBe("");
  });

  it("does not expose a panel control for an unrecognized or failed handoff", () => {
    expect(getAdminRecognitionView(false, "")).toBe("hidden");
    expect(getAdminRecognitionView(false, "handoff failed")).toBe("error");
    expect(getAdminRecognitionView(true, "handoff failed")).toBe("recognized");
  });

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

  it("shares one handoff task across duplicate lifecycle effects", async () => {
    let resolveTask: () => void = () => undefined;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    let calls = 0;
    const operation = () => {
      calls += 1;
      return task;
    };

    const first = runAdminHandoffOnce("one", "https://wedding.test", operation);
    const second = runAdminHandoffOnce(
      "one",
      "https://wedding.test",
      operation,
    );
    expect(first).toBe(second);
    expect(calls).toBe(1);
    resolveTask();
    await first;

    await runAdminHandoffOnce("one", "https://wedding.test", operation);
    expect(calls).toBe(2);
  });
});
