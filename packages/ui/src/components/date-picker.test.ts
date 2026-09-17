import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatePicker } from "./date-picker";

const pickerSource = readFileSync(
  resolve(import.meta.dirname, "date-picker.tsx"),
  "utf8",
);

describe("DatePicker form semantics", () => {
  it("uses a validation-participating date input for required values", () => {
    const markup = renderToStaticMarkup(
      React.createElement(DatePicker, { name: "eventDate", required: true }),
    );

    expect(markup).toContain('type="date"');
    expect(markup).toContain('name="eventDate"');
    expect(markup).toContain('value=""');
    expect(markup).toContain("required");
    expect(markup).toContain('tabindex="-1"');
  });

  it("mirrors disabled state to the submitted date input", () => {
    const markup = renderToStaticMarkup(
      React.createElement(DatePicker, {
        name: "eventDate",
        required: true,
        disabled: true,
      }),
    );

    expect(markup).toMatch(
      /<input(?=[^>]*type="date")(?=[^>]*name="eventDate")(?=[^>]*disabled="")[^>]*>/,
    );
  });

  it("keeps the trigger inside the form column", () => {
    expect(pickerSource).toContain("min-w-0 max-w-full");
    expect(pickerSource).toContain('align="start"');
    expect(pickerSource).toContain("data-date-picker-trigger");
  });
});
