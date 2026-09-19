import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootSource = readFileSync(
  resolve(import.meta.dirname, "routes/__root.tsx"),
  "utf8",
);
const tailwindSource = readFileSync(
  resolve(import.meta.dirname, "tailwind.css"),
  "utf8",
);
const adminTransitionSources = ["components/AdminShell.tsx"].map(
  (relativePath) => ({
    path: relativePath,
    source: readFileSync(resolve(import.meta.dirname, relativePath), "utf8"),
  }),
);
const responsiveSources = [
  "lib/adminStyles.ts",
  "components/AdminShell.tsx",
  "components/AuthLayout.tsx",
  "components/GuestGroupsSection.tsx",
  "components/MessagesSection.tsx",
  "components/Panel.tsx",
  "components/RsvpSection.tsx",
  "components/SiteWorkspace.tsx",
  "components/SmsUsageSection.tsx",
].map((relativePath) => ({
  path: relativePath,
  source: readFileSync(resolve(import.meta.dirname, relativePath), "utf8"),
}));
const adminStylesSource = readFileSync(
  resolve(import.meta.dirname, "lib/adminStyles.ts"),
  "utf8",
);
const smsUsageSource = readFileSync(
  resolve(import.meta.dirname, "components/SmsUsageSection.tsx"),
  "utf8",
);

describe("admin Tailwind policy", () => {
  it("uses the Tailwind entrypoint without a legacy stylesheet", () => {
    expect(rootSource).toContain('import "../tailwind.css";');
    expect(rootSource).not.toContain('import "../styles.css";');
    expect(() =>
      readFileSync(resolve(import.meta.dirname, "styles.css")),
    ).toThrow();
  });

  it("keeps the admin stylesheet limited to Tailwind directives", () => {
    expect(tailwindSource).not.toMatch(
      /(^|\n)\s*(?!@(?:import|source|theme|keyframes)\b)[.#[a-zA-Z][^\n]*\{/,
    );
    expect(tailwindSource).not.toContain("@apply");
  });

  it("keeps reduced-motion coverage on every transitioning admin primitive", () => {
    for (const { path, source } of adminTransitionSources) {
      expect(source, path).toMatch(/\btransition(?:-[^\s"`]+)?/);
      expect(source, path).toContain("motion-reduce:transition-none");
    }
  });

  it("keeps legacy responsive boundaries inclusive in Tailwind utilities", () => {
    const source = responsiveSources.map(({ source }) => source).join("\n");

    expect(source).not.toContain("max-[760px]:");
    expect(source).not.toContain("max-[600px]:");
    expect(source).not.toContain("min-[761px]:max-[1060px]:");
    expect(source).toContain("[@media(max-width:760px)]:");
    expect(source).toContain("[@media(max-width:600px)]:");
    expect(source).toContain(
      "[@media(min-width:761px)_and_(max-width:1060px)]:",
    );
  });

  it("keeps legacy data-form focus treatment in Tailwind form utilities", () => {
    expect(adminStylesSource).toContain(
      "[&_input:focus]:border-admin-terracotta",
    );
    expect(adminStylesSource).toContain(
      "[&_textarea:focus]:border-admin-terracotta",
    );
    expect(adminStylesSource).toContain(
      "[&_select:focus]:border-admin-terracotta",
    );
    expect(adminStylesSource).toContain("[&_input:focus]:outline-[3px]");
    expect(adminStylesSource).toContain(
      "[&_input:focus]:outline-[rgb(168_77_57_/_20%)]",
    );
  });

  it("keeps the SMS quota control on the legacy admin surface token", () => {
    expect(smsUsageSource).toContain('id="sms-monthly-limit"');
    expect(smsUsageSource).toContain("border-admin-line");
    expect(smsUsageSource).toContain("bg-admin-surface");
    expect(smsUsageSource).toContain("focus:border-admin-terracotta");
  });
});
