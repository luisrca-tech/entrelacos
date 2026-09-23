import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const messagesSource = readFileSync(
  resolve(import.meta.dirname, "MessagesSection.tsx"),
  "utf8",
);
describe("message rows use the invitation surface", () => {
  it("keeps moderation actions on each invitation row", () => {
    expect(messagesSource).toContain("Bloquear envios");
    expect(messagesSource).toContain("Remover mensagem");
    expect(messagesSource).toContain('size="sm"');
    expect(messagesSource).not.toContain("CardAction");
    expect(messagesSource).not.toContain("clamp(1.8rem");
    expect(messagesSource).not.toContain("Badge");
  });

  it("keeps messages on one bordered surface", () => {
    expect(messagesSource).toContain("adminStyles.surface");
    expect(messagesSource).toContain("border-b border-admin-line");
  });
});
