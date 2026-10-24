import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "./password-input";

describe("PasswordInput", () => {
  it("starts hidden and exposes a show control", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PasswordInput, {
        id: "login-password",
        name: "password",
        autoComplete: "current-password",
        required: true,
        maxLength: 200,
      }),
    );

    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('type="text"');
    expect(markup).toContain('id="login-password"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain("required");
    expect(markup).toContain('maxLength="200"');
    expect(markup).toContain("pr-11!");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Mostrar senha"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("lucide-eye");
    expect(markup).not.toContain("lucide-eye-off");
  });

  it("disables the visibility control with the field", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PasswordInput, {
        name: "password",
        disabled: true,
      }),
    );

    expect(markup).toMatch(
      /<input(?=[^>]*name="password")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*type="button")(?=[^>]*disabled="")[^>]*>/,
    );
  });
});
