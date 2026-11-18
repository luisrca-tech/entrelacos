import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as ui from "../index";
import { PaymentProviderDisclosure } from "./payment-provider-disclosure";

describe("PaymentProviderDisclosure", () => {
  it("names the payment provider as text only", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PaymentProviderDisclosure),
    );

    expect(markup).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a");
  });

  it("replaces the previous provider export", () => {
    expect(ui).toHaveProperty("PaymentProviderDisclosure");
    expect(
      Object.keys(ui).filter((name) => name.endsWith("Disclosure")),
    ).toEqual(["PaymentProviderDisclosure"]);
  });
});
