import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminRecognition } from "./AdminRecognition";
import {
  adminIntroBody,
  adminIntroConfirmLabel,
  adminIntroStorageKey,
  adminIntroTitle,
  adminPanelLinkLabel,
  createRecognitionChallenge,
  getAdminRecognitionView,
  panelHandoffUrl,
  readAdminIntroDismissed,
  runAdminHandoffOnce,
  shouldShowAdminIntro,
  writeAdminIntroDismissed,
} from "./adminRecognition";

const source = readFileSync(
  resolve(import.meta.dirname, "AdminRecognition.tsx"),
  "utf8",
);
const styles = readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

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

  it("shows a recognized Painel link without a persistent administrator-mode status", () => {
    expect(adminPanelLinkLabel).toBe("Painel");
    expect(source).toContain("{adminPanelLinkLabel}");
    expect(source).not.toContain("Voltar ao painel");
    expect(source).not.toContain('role="status">Modo administrador');
  });

  it("explains administrator mode in a confirmable banner", () => {
    expect(adminIntroTitle).toBe("Modo administrador");
    expect(adminIntroConfirmLabel).toBe("Entendi");
    expect(adminIntroBody).toBe(
      "Você está vendo o site como administrador. Convidados não veem o link Painel no topo. Use-o para voltar ao painel a qualquer momento.",
    );
    expect(source).toContain('role="dialog"');
    expect(source).toContain("createPortal");
    expect(source).toContain("{adminIntroTitle}");
    expect(source).toContain("{adminIntroBody}");
    expect(source).toContain("{adminIntroConfirmLabel}");
  });

  it("explains administrator mode once until the visitor confirms", () => {
    expect(shouldShowAdminIntro(false, false)).toBe(false);
    expect(shouldShowAdminIntro(false, true)).toBe(false);
    expect(shouldShowAdminIntro(true, true)).toBe(false);
    expect(shouldShowAdminIntro(true, false)).toBe(true);
  });

  it("namespaces the intro dismissal per site and survives blocked storage", () => {
    const storage = memoryStorage();
    expect(adminIntroStorageKey("one")).toBe("entrelacos:admin-intro:one");
    expect(adminIntroStorageKey("one")).not.toBe(adminIntroStorageKey("two"));
    expect(readAdminIntroDismissed(storage, "one")).toBe(false);
    writeAdminIntroDismissed(storage, "one");
    expect(readAdminIntroDismissed(storage, "one")).toBe(true);
    expect(readAdminIntroDismissed(storage, "two")).toBe(false);
    expect(readAdminIntroDismissed(undefined, "one")).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAdminIntroDismissed(blocked, "one")).toBe(false);
    expect(() => writeAdminIntroDismissed(blocked, "one")).not.toThrow();
  });

  it("pins the intro to the viewport bottom and enters with template motion", () => {
    const rule = styles.match(/\.admin-intro\s*\{[^}]*\}/s)?.[0];
    expect(rule).toContain("position: fixed;");
    expect(rule).toContain("bottom: 0;");
    expect(rule).toContain("top: auto;");
    expect(rule).toMatch(/animation:\s*admin-intro-enter/);
    expect(styles).toContain("@keyframes admin-intro-enter");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.admin-intro\s*\{[\s\S]*?animation:\s*none;/,
    );
  });
});
