// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdminButton,
  type AdminButtonTone,
  adminButtonClassName,
} from "./AdminButton";

const expectedClasses: Record<AdminButtonTone, string[]> = {
  primary: [
    "bg-admin-accent",
    "text-admin-on-accent",
    "hover:bg-admin-accent-hover",
  ],
  secondary: ["bg-admin-surface", "border-admin-border", "text-admin-text"],
  danger: ["bg-admin-danger", "text-admin-on-accent"],
  ghost: ["text-admin-accent-hover", "hover:bg-admin-accent-subtle"],
  link: ["text-admin-accent-hover", "hover:underline"],
};

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function render(
  tone: AdminButtonTone,
  className?: string,
): Promise<HTMLButtonElement> {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(createElement(AdminButton, { tone, className }, "Ação")),
  );
  cleanup = () => {
    act(() => root.unmount());
    node.remove();
  };
  const button = node.querySelector("button");
  if (!button) throw new Error("AdminButton did not render a button");
  return button;
}

describe("AdminButton", () => {
  for (const [tone, classes] of Object.entries(expectedClasses) as [
    AdminButtonTone,
    string[],
  ][]) {
    it(`maps the ${tone} tone to admin tokens without the shared dark default`, async () => {
      const button = await render(tone);
      const rendered = button.className.split(/\s+/);

      for (const expected of classes) expect(rendered).toContain(expected);
      expect(button.className).not.toMatch(
        /(?:^|\s)(?:[\w-]+:)*(?:bg|text|border|ring)-(?:foreground|background|primary|ring|border|muted|input)(?:\/\d+)?(?=\s|$)/,
      );
      expect(rendered).toContain("focus-visible:ring-admin-accent/30");
      expect(rendered).toContain("focus-visible:border-admin-accent");
    });
  }

  it("exposes the same tone classes for links styled as buttons", () => {
    const classes = adminButtonClassName("secondary", "no-underline").split(
      /\s+/,
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        ...expectedClasses.secondary,
        "focus-visible:ring-admin-accent/30",
        "no-underline",
      ]),
    );
    expect(classes).not.toContain("border-border");
    expect(classes).not.toContain("bg-background");
  });

  it("lets callers extend the tone with layout classes", async () => {
    const button = await render("primary", "w-fit min-h-12");

    expect(button.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-fit", "min-h-12", "bg-admin-accent"]),
    );
  });
});
