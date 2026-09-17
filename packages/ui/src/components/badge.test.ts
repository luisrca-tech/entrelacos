import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("merges custom utility classes over variant utilities", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Badge, { className: "bg-secondary" }, "Draft"),
    );

    expect(markup).toContain("bg-secondary");
    expect(markup).not.toContain("bg-primary");
  });
});
