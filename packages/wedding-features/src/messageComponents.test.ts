import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicMuralResponse } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FamilyMessageForm } from "./FamilyMessageForm";
import { mergeMuralMessages } from "./MessageMural";

const guestAccessSource = readFileSync(
  resolve(import.meta.dirname, "GuestAccessPanel.tsx"),
  "utf8",
);

const message = {
  id: "message-a",
  authorName: "Ana Silva",
  groupName: "Família Silva",
  text: "Viva os noivos!",
  revision: 1,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
};

describe("family message form", () => {
  it("shows the Unicode counter and disables unchanged submissions", () => {
    const html = renderToStaticMarkup(
      createElement(FamilyMessageForm, {
        message,
        currentRevision: 1,
        canEdit: true,
        readOnlyReason: null,
        value: "Viva os noivos!",
        busy: false,
        onChange: vi.fn(),
        onSave: vi.fn(),
      }),
    );

    expect(html).toContain("15 / 1000");
    expect(html).toContain("Viva os noivos!");
    expect(html).toContain("grid gap-4 border-t border-template-line pt-6");
    expect(html).toContain("data-[invalid=true]:font-bold");
    expect(html).toContain('disabled=""');
  });

  it("keeps a moderated group message visible while explaining the block", () => {
    const html = renderToStaticMarkup(
      createElement(FamilyMessageForm, {
        message,
        currentRevision: 1,
        canEdit: false,
        readOnlyReason: "MESSAGE_BLOCKED",
        value: message.text,
        busy: false,
        onChange: vi.fn(),
        onSave: vi.fn(),
      }),
    );

    expect(html).toContain("Viva os noivos!");
    expect(html).toContain("bloqueou novas mensagens");
    expect(html).toContain('disabled=""');
  });

  it("explains why a nonblank message cannot be published", () => {
    const html = renderToStaticMarkup(
      createElement(FamilyMessageForm, {
        message: null,
        currentRevision: 0,
        canEdit: true,
        readOnlyReason: null,
        value: "Parab<ens>",
        busy: false,
        onChange: vi.fn(),
        onSave: vi.fn(),
      }),
    );

    expect(html).toContain("Use somente texto simples");
    expect(html).toContain('disabled=""');
  });
});

describe("guest lookup form", () => {
  it("uses the localized application validation path", () => {
    expect(guestAccessSource).toContain("className={guestAccessFormClass}");
    expect(guestAccessSource).toContain("onSubmit={startLookup}");
    expect(guestAccessSource).toContain(
      "Informe o nome completo e um celular brasileiro válido.",
    );
    expect(guestAccessSource).toContain("Celular");
    expect(guestAccessSource).not.toContain("Celular brasileiro");
    expect(guestAccessSource).not.toContain(
      "Autorização temporária da demonstração",
    );
    expect(guestAccessSource).toContain("use o PIN");
    expect(guestAccessSource).toContain("do seu grupo");
    expect(guestAccessSource).not.toContain(
      "entrelacos-guest-access__foreign-note",
    );
  });

  it("keeps guest verification PIN-only", () => {
    expect(guestAccessSource).toContain("PIN de 6 dígitos");
    expect(guestAccessSource).not.toMatch(
      /deliveryMode|simulationCode|resendCode|Reenviar|SMS/,
    );
  });

  it("centers a wider confirmation column on desktop without wrapping the title", () => {
    expect(guestAccessSource).toContain("min-[961px]:justify-items-center");
    expect(guestAccessSource).toContain(
      "min-[961px]:w-full min-[961px]:max-w-[52rem]",
    );
    expect(guestAccessSource).toContain("min-[961px]:whitespace-nowrap");
    expect(guestAccessSource).toContain("min-[961px]:max-w-[38rem]");
    expect(guestAccessSource).toContain("[@media(max-width:560px)]:flex-col");
  });
});

describe("message mural pagination", () => {
  it("replaces stale pages on refresh and deduplicates appended pages", () => {
    const first: PublicMuralResponse["messages"] = [
      {
        id: "message-a",
        authorName: "Ana Silva",
        groupName: "Família Silva",
        text: "Viva os noivos!",
        createdAt: "2026-09-12T12:00:00.000Z",
        updatedAt: "2026-09-12T12:00:00.000Z",
      },
    ];
    const second: PublicMuralResponse["messages"] = [
      { ...first[0] },
      {
        ...first[0],
        id: "message-b",
        authorName: "Bruno",
        text: "Felicidades!",
      },
    ];

    expect(mergeMuralMessages(first, second, false)).toEqual(second);
    expect(mergeMuralMessages(first, second, true).map(({ id }) => id)).toEqual(
      ["message-a", "message-b"],
    );
  });
});
