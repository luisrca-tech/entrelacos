import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const messagesSource = readFileSync(
  resolve(import.meta.dirname, "MessagesSection.tsx"),
  "utf8",
);
describe("public message moderation", () => {
  it("lists independent messages and removes the selected message by ID", () => {
    expect(messagesSource).toContain("response.messages");
    expect(messagesSource).toContain("messages.map((message)");
    expect(messagesSource).toContain("removeTarget.id");
    expect(messagesSource).toContain("Remover mensagem");
    expect(messagesSource).not.toContain("message-block");
  });

  it("keeps the mural switch and moderation feedback", () => {
    expect(messagesSource).toContain("mural-enabled");
    expect(messagesSource).toContain("toast.success(success)");
    expect(messagesSource).toContain("toast.error(message)");
    expect(messagesSource).toContain(
      "Visitantes podem publicar novas mensagens.",
    );
    expect(messagesSource).toContain(
      "As mensagens existentes continuam visíveis.",
    );
    expect(messagesSource).not.toContain("setNotice");
  });

  it("searches by author through the paginated API request", () => {
    expect(messagesSource).toContain("message-author-search");
    expect(messagesSource).toContain("messagesQuery(search, cursor)");
    expect(messagesSource).toContain("requestVersionForLoad");
    expect(messagesSource).toContain("searchInputRef.current");
    expect(messagesSource).toContain("setNextCursor(null)");
  });
});
