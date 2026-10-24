import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GiftsLocked } from "./GiftsLocked";

describe("locked gift catalog", () => {
  it("explains the receiving prerequisite without editable controls", () => {
    const html = renderToStaticMarkup(createElement(GiftsLocked));
    expect(html).toContain("Configure os recebimentos primeiro");
    expect(html).toContain("verificação do recebedor e da conta de destino");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Adicionar presente");
    expect(html).not.toContain("<button");
  });

  it("shows a receiving action only when the authorized composition supplies it", () => {
    const html = renderToStaticMarkup(
      createElement(GiftsLocked, {
        receivingAction: createElement(
          "a",
          { href: "/receiving" },
          "Configurar recebimentos",
        ),
      }),
    );
    expect(html).toContain("Configurar recebimentos");
    expect(html).toContain('href="/receiving"');
    expect(html).not.toContain("Adicionar presente");
  });
});
