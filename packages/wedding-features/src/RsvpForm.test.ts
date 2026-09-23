import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RsvpForm } from "./RsvpForm";

describe("invitation RSVP form", () => {
  it("shows each guest type and no representative role", () => {
    const html = renderToStaticMarkup(
      createElement(RsvpForm, {
        open: true,
        guests: [
          { guestId: "guest-a", fullName: "Ana", guestType: "ADULT" },
          { guestId: "guest-b", fullName: "Bia", guestType: "CHILD" },
        ],
        draft: {
          "guest-a": {
            state: "PENDING",
            persistedState: "PENDING",
            revision: 0,
          },
          "guest-b": {
            state: "CONFIRMED",
            persistedState: "CONFIRMED",
            revision: 1,
          },
        },
        canEdit: true,
        busy: false,
        onChange: vi.fn(),
        onConfirmAll: vi.fn(),
        onSave: vi.fn(),
        onReload: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("Adulto");
    expect(html).toContain("Criança");
    expect(html).not.toContain("Responsável pelo convite");
  });
});
