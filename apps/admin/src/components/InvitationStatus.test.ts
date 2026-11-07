import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationStatus } from "./InvitationStatus";

describe("invitation status", () => {
  it.each([
    ["PENDING", "Sem resposta", "bg-admin-pending"],
    ["CONFIRMED", "Irá comparecer", "bg-admin-success"],
    ["DECLINED", "Não comparecerá", "bg-admin-danger"],
  ] as const)("renders %s with color and text", (state, label, token) => {
    const html = renderToStaticMarkup(
      createElement(InvitationStatus, { state }),
    );
    expect(html).toContain(label);
    expect(html).toContain(token);
  });
});
