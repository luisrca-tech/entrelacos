import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicMuralResponse } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMuralVisibility, mergeMuralMessages } from "./MessageMural";
import { PublicMessageForm } from "./PublicMessageForm";

const guestAccessSource = readFileSync(
  resolve(import.meta.dirname, "GuestAccessPanel.tsx"),
  "utf8",
);
const muralSource = readFileSync(
  resolve(import.meta.dirname, "MessageMural.tsx"),
  "utf8",
);
const messageDialogSource = readFileSync(
  resolve(import.meta.dirname, "PublicMessageDialog.tsx"),
  "utf8",
);
const siteDialogSource = readFileSync(
  resolve(import.meta.dirname, "SiteDialog.tsx"),
  "utf8",
);

const message = {
  id: "message-a",
  authorName: "Ana Silva",
  text: "Viva os noivos!",
  createdAt: "2026-09-12T12:00:00.000Z",
};

describe("public message form", () => {
  it("requires an author name and message", () => {
    const html = renderToStaticMarkup(
      createElement(PublicMessageForm, {
        authorName: "Ana Silva",
        message: "Viva os noivos!",
        busy: false,
        onAuthorNameChange: vi.fn(),
        onMessageChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(html).toContain("Seu nome");
    expect(html).toContain("Mensagem");
    expect(html).toContain('name="authorName"');
    expect(html).toContain('name="text"');
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).toContain("Ana Silva");
    expect(html).toContain("Viva os noivos!");
  });

  it("keeps entered values visible with the error after a failed post", () => {
    const html = renderToStaticMarkup(
      createElement(PublicMessageForm, {
        authorName: "Ana Silva",
        message: "Viva os noivos!",
        busy: false,
        error: "Tente novamente em 60 segundos.",
        onAuthorNameChange: vi.fn(),
        onMessageChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Tente novamente em 60 segundos.");
    expect(html).toContain("Ana Silva");
    expect(html).toContain("Viva os noivos!");
  });

  it("disables invalid or empty submissions", () => {
    const html = renderToStaticMarkup(
      createElement(PublicMessageForm, {
        authorName: " ",
        message: "Parab<ens>",
        busy: false,
        onAuthorNameChange: vi.fn(),
        onMessageChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(html).toContain("Use somente texto simples");
    expect(html).toContain('disabled=""');
  });

  it("rejects angle brackets and control characters in names", () => {
    for (const authorName of ["Ana <Silva>", "Ana\u0000 Silva"]) {
      const html = renderToStaticMarkup(
        createElement(PublicMessageForm, {
          authorName,
          message: "Viva os noivos!",
          busy: false,
          onAuthorNameChange: vi.fn(),
          onMessageChange: vi.fn(),
          onSubmit: vi.fn(),
        }),
      );

      expect(html).toContain("sem sinais de maior ou menor");
      expect(html).toContain('disabled=""');
    }
  });

  it("accepts accented and repeated author names", () => {
    for (const authorName of ["José da Silva", "José da Silva"]) {
      const html = renderToStaticMarkup(
        createElement(PublicMessageForm, {
          authorName,
          message: "Viva os noivos!",
          busy: false,
          onAuthorNameChange: vi.fn(),
          onMessageChange: vi.fn(),
          onSubmit: vi.fn(),
        }),
      );

      expect(html).toContain("José da Silva");
      expect(html).not.toContain('disabled=""');
    }
  });

  it("counts a public author name by Unicode code points", () => {
    const html = renderToStaticMarkup(
      createElement(PublicMessageForm, {
        authorName: "🎉".repeat(100),
        message: "Viva os noivos!",
        busy: false,
        onAuthorNameChange: vi.fn(),
        onMessageChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(html).not.toContain('disabled=""');

    const tooLongHtml = renderToStaticMarkup(
      createElement(PublicMessageForm, {
        authorName: "🎉".repeat(161),
        message: "Viva os noivos!",
        busy: false,
        onAuthorNameChange: vi.fn(),
        onMessageChange: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(tooLongHtml).toContain('disabled=""');
  });
});

describe("invitation access form", () => {
  it("uses the localized application validation path", () => {
    expect(guestAccessSource).toContain("className={guestAccessFormClass}");
    expect(guestAccessSource).toContain("onSubmit={accessInvitation}");
    expect(guestAccessSource).toContain(
      'toast.error(\n        "Informe um telefone válido e o PIN de 6 dígitos do convite.",\n      );',
    );
    expect(guestAccessSource).toContain('toast.success("Acesso confirmado.")');
    expect(guestAccessSource).not.toContain("setNotice");
    expect(guestAccessSource).toContain("Telefone de contato");
    expect(guestAccessSource).toContain("formatInvitationPhoneInput");
    expect(guestAccessSource).not.toContain("Nome completo\n");
    expect(guestAccessSource).not.toContain("do seu grupo");
  });

  it("keeps guest verification PIN-only", () => {
    expect(guestAccessSource).toContain("PIN de 6 dígitos");
    expect(guestAccessSource).not.toMatch(
      /deliveryMode|simulationCode|resendCode|Reenviar|SMS/,
    );
  });

  it("keeps confirmation in the access panel and leaves messages to the mural", () => {
    expect(guestAccessSource).not.toContain("PublicMessageForm");
    expect(guestAccessSource).toContain("publishGuestSessionChange");
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

  it("places the opened invitation beside the intro, like the split sections", () => {
    expect(guestAccessSource).toContain(
      "grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]",
    );
    expect(guestAccessSource).toContain("[@media(max-width:960px)]:block");
    expect(guestAccessSource).toContain(
      "showingInvitation\n          ? guestAccessAuthenticatedSectionClass",
    );
  });
});

describe("public mural compose", () => {
  it("offers public posting without tying the mural to guest session state", () => {
    expect(muralSource).toContain("Deixar uma mensagem");
    expect(muralSource).not.toContain("hasSession");
    expect(muralSource).not.toContain("readGuestSession");
    expect(muralSource).not.toContain("guestSessionEventName");
    expect(muralSource).not.toContain("invitationName");
    expect(messageDialogSource).toContain("<SiteDialog");
    expect(siteDialogSource).toContain("m-auto");
    expect(messageDialogSource).toContain("createPublicSiteMessage");
    expect(messageDialogSource).toContain("muralRefreshEventName");
    expect(messageDialogSource).not.toContain("getInvitationMessage");
    expect(messageDialogSource).not.toContain("readGuestSession");
  });
});

describe("message mural pagination", () => {
  it("replaces stale pages on refresh and deduplicates appended pages", () => {
    const first: PublicMuralResponse["messages"] = [message];
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

describe("public mural visibility", () => {
  it("keeps stored cards and pagination visible while new posts are paused", () => {
    expect(getMuralVisibility(false, 2, true)).toEqual({
      showComposer: false,
      showMessages: true,
      showEmptyState: false,
      showPausedStatus: true,
      showMore: true,
    });
  });

  it("shows only two columns on wide screens and one on narrow screens", () => {
    expect(muralSource).toContain(
      "grid-cols-2 gap-4 p-0 [@media(max-width:560px)]:grid-cols-1",
    );
  });

  it("closes an open composer after publishing is paused", () => {
    expect(muralSource).toContain(
      "if (!result.enabled) setMessageOpen(false);",
    );
  });
});
