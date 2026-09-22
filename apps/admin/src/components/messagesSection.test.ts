import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const messagesSource = readFileSync(
  resolve(import.meta.dirname, "MessagesSection.tsx"),
  "utf8",
);
describe("message cards use shared card chrome", () => {
  it("uses a compact header with CardAction buttons", () => {
    expect(messagesSource).toContain(
      'className="flex w-full flex-row items-start justify-between"',
    );
    expect(messagesSource).toContain("CardAction");
    expect(messagesSource).toContain('size="sm"');
    expect(messagesSource).toMatch(/CardAction[\s\S]*Bloquear envios/);
    expect(messagesSource).toMatch(/CardAction[\s\S]*Remover mensagem/);
    expect(messagesSource).toContain("CardDescription");
    expect(messagesSource).not.toContain("Badge");
  });

  it("keeps message cards on the shared card surface", () => {
    expect(messagesSource).toContain("border-admin-line");
    expect(messagesSource).toContain("bg-admin-surface");
  });
});
