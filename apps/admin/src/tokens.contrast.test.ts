import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tailwindSource = readFileSync(
  resolve(import.meta.dirname, "tailwind.css"),
  "utf8",
);

const declarations = new Map(
  [...tailwindSource.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(
    ([, name, value]) => [name, value.trim()] as const,
  ),
);

function token(name: string): string {
  let value = declarations.get(`--color-admin-${name}`);
  for (let depth = 0; value?.startsWith("var(") && depth < 5; depth += 1) {
    value = declarations.get(value.slice(4, -1).trim());
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`admin-${name} does not resolve to a hex color`);
  }
  return value;
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

const textPairs = [
  ["text", "canvas"],
  ["text", "surface"],
  ["text", "subtle"],
  ["text-secondary", "canvas"],
  ["text-secondary", "surface"],
  ["text-secondary", "subtle"],
  ["accent-hover", "accent-subtle"],
  ["accent-hover", "surface"],
  ["accent-hover", "canvas"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["on-accent", "success"],
  ["on-accent", "danger"],
  ["success-text", "success-subtle"],
  ["success-text", "surface"],
  ["pending-text", "pending-subtle"],
  ["pending-text", "surface"],
  ["danger-text", "danger-subtle"],
  ["danger-text", "surface"],
] as const;

describe("admin color token contrast", () => {
  it.each(textPairs)(
    "keeps admin-%s on admin-%s at WCAG AA for normal text",
    (foreground, background) => {
      expect(
        contrast(token(foreground), token(background)),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
