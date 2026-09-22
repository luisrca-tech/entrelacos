import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationStatus } from "./InvitationStatus";

describe("invitation status", () => {
  it.each([
    ["PENDING", "Sem resposta", "admin-status-pending"],
    ["CONFIRMED", "Irá comparecer", "admin-status-confirmed"],
    ["DECLINED", "Não comparecerá", "admin-status-declined"],
  ] as const)("renders %s with color and text", (state, label, token) => {
    const html = renderToStaticMarkup(
      createElement(InvitationStatus, { state }),
    );
    expect(html).toContain(label);
    expect(html).toContain(token);
  });
});
