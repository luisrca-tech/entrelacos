import { readdirSync, readFileSync } from "node:fs";
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
  "components/InvitationsSection.tsx",
  "components/InvitationList.tsx",
  "components/MessagesSection.tsx",
  "components/Panel.tsx",
  "components/SiteWorkspace.tsx",
].map((relativePath) => ({
  path: relativePath,
  source: readFileSync(resolve(import.meta.dirname, relativePath), "utf8"),
}));
const adminStylesSource = readFileSync(
  resolve(import.meta.dirname, "lib/adminStyles.ts"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve(import.meta.dirname, "components/SiteWorkspace.tsx"),
  "utf8",
);
const invitationsSource = readFileSync(
  resolve(import.meta.dirname, "components/InvitationsSection.tsx"),
  "utf8",
);

const adminSourceFiles = readdirSync(import.meta.dirname, { recursive: true })
  .map(String)
  .filter(
    (relativePath) =>
      /\.(?:ts|tsx)$/.test(relativePath) &&
      !/\.test\.(?:ts|tsx)$/.test(relativePath) &&
      !relativePath.endsWith("routeTree.gen.ts"),
  )
  .map((relativePath) => ({
    path: relativePath,
    source: readFileSync(resolve(import.meta.dirname, relativePath), "utf8"),
  }));

const semanticColorTokens = [
  "canvas",
  "surface",
  "subtle",
  "subtle-hover",
  "border",
  "border-strong",
  "text",
  "text-secondary",
  "on-accent",
  "accent",
  "accent-hover",
  "accent-subtle",
  "success",
  "success-subtle",
  "success-text",
  "pending",
  "pending-subtle",
  "pending-text",
  "danger",
  "danger-subtle",
  "danger-text",
] as const;

const removedColorTokens = [
  "beige",
  "beige-deep",
  "ink",
  "graphite",
  "body",
  "muted",
  "line",
  "line-strong",
  "terracotta",
  "terracotta-deep",
  "terracotta-ink",
  "terracotta-wash",
  "success-wash",
  "success-ink",
  "success-line",
  "pending-wash",
  "pending-ink",
  "danger-wash",
  "danger-ink",
  "status-pending",
  "status-confirmed",
  "status-declined",
  "awaiting",
] as const;

const colorUtility =
  "(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration)";

function findAll(pattern: RegExp) {
  return adminSourceFiles.flatMap(({ path, source }) =>
    [...source.matchAll(pattern)].map((match) => `${path}: ${match[0]}`),
  );
}

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
    expect(adminStylesSource).toContain("[&_input:focus]:border-admin-accent");
    expect(adminStylesSource).toContain(
      "[&_textarea:focus]:border-admin-accent",
    );
    expect(adminStylesSource).toContain("[&_select:focus]:border-admin-accent");
    expect(adminStylesSource).toContain('checkbox: "flex! items-center gap-2"');
    expect(adminStylesSource).toContain("[&_input:focus]:outline-[3px]");
    expect(adminStylesSource).toContain(
      "[&_input:focus]:outline-admin-accent/20",
    );
  });

  it("removes SMS quota and delivery UI from the admin workspace", () => {
    expect(workspaceSource).not.toContain("SmsUsageSection");
    expect(workspaceSource).not.toContain("sms-usage");
    expect(invitationsSource).not.toContain("SMS");
    expect(invitationsSource).not.toContain("demo-grant");
  });
  it("defines only the semantic admin color tokens, backed by the primitive palette", () => {
    const defined = [
      ...tailwindSource.matchAll(/--color-admin-([a-z-]+):\s*([^;]+);/g),
    ];

    expect(defined.map(([, name]) => name).sort()).toEqual(
      [...semanticColorTokens].sort(),
    );
    for (const [, name, value] of defined) {
      expect(value, name).toMatch(/^var\(--palette-[a-z]+-\d+\)$/);
    }
    for (const name of removedColorTokens) {
      expect(tailwindSource).not.toMatch(
        new RegExp(`--color-admin-${name}(?![\\w-])`),
      );
    }
  });

  it("keeps raw colors out of admin source files", () => {
    expect(findAll(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g)).toEqual([]);
    expect(findAll(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/g)).toEqual([]);
  });

  it("keeps Tailwind default palette colors out of admin source files", () => {
    expect(
      findAll(
        new RegExp(
          `\\b${colorUtility}-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\\b`,
          "g",
        ),
      ),
    ).toEqual([]);
    expect(
      findAll(new RegExp(`\\b${colorUtility}-(?:white|black)\\b`, "g")),
    ).toEqual([]);
  });

  it("keeps admin source files on semantic admin color tokens", () => {
    const allowed = new Set<string>(semanticColorTokens);
    const used = adminSourceFiles.flatMap(({ path, source }) =>
      [
        ...source.matchAll(
          new RegExp(
            `\\b${colorUtility}-admin-([a-z]+(?:-[a-z]+)*)|--color-admin-([a-z]+(?:-[a-z]+)*)`,
            "g",
          ),
        ),
      ].map((match) => ({ path, name: match[1] ?? match[2] ?? "" })),
    );

    expect(used.length).toBeGreaterThan(0);
    expect(
      used
        .filter(({ name }) => !allowed.has(name))
        .map(({ path, name }) => `${path}: admin-${name}`),
    ).toEqual([]);
    expect(findAll(/--palette-[a-z]+-\d+/g)).toEqual([]);
    expect(
      findAll(
        /\b(?:bg|text|border)-(?:sand|terracotta|forest|ochre|brick)-\d+/g,
      ),
    ).toEqual([]);
  });

  it("styles selected toggles with the accent-subtle pattern instead of a dark pill", () => {
    expect(findAll(/\?\s*"default"\s*:\s*"(?:ghost|outline)"/g)).toEqual([]);
  });

  it("renders every admin button through AdminButton instead of the shared dark default", () => {
    // These shared exports render the packages/ui Button variants directly,
    // whose default resolves to the dark `bg-foreground` pill.
    const sharedButtonExports = new Set([
      "Button",
      "buttonVariants",
      "AlertDialogAction",
      "AlertDialogCancel",
    ]);
    const offenders = adminSourceFiles
      .filter(({ path }) => path !== "components/AdminButton.tsx")
      .flatMap(({ path, source }) => [
        ...[
          ...source.matchAll(
            /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@entrelacos\/ui"/g,
          ),
        ]
          .flatMap(([, specifiers = ""]) =>
            specifiers.split(",").map(
              (specifier) =>
                specifier
                  .trim()
                  .replace(/^type\s+/, "")
                  .split(/\s+as\s+/)[0],
            ),
          )
          .filter((name) => name && sharedButtonExports.has(name))
          .map((name) => `${path}: imports ${name}`),
        ...[...source.matchAll(/<Button\b/g)].map(() => `${path}: <Button`),
      ]);

    expect(offenders).toEqual([]);
    expect(
      findAll(/import\s*\*\s*as\s+\w+\s+from\s*"@entrelacos\/ui"/g),
    ).toEqual([]);
  });

  it("gives every admin button and link the accent/30 focus outline", () => {
    for (const element of ["button", "a"]) {
      expect(rootSource).toContain(
        `[&_${element}:focus-visible]:outline-admin-accent/30`,
      );
      expect(rootSource).not.toContain(
        `[&_${element}:focus-visible]:outline-admin-accent/20`,
      );
      // Shared primitives set `outline-none`; the root must restore the style.
      expect(rootSource).toContain(
        `[&_${element}:focus-visible]:outline-solid`,
      );
    }
    // The root outline replaces the shared ring on every button.
    expect(rootSource).toContain("[&_button:focus-visible]:ring-0");
  });

  it("resolves the shared primary, link and focus colors to the admin accent", () => {
    expect(tailwindSource).toContain(
      "--color-primary: var(--color-admin-accent);",
    );
    expect(tailwindSource).toContain(
      "--color-primary-foreground: var(--color-admin-on-accent);",
    );
    expect(tailwindSource).toContain(
      "--color-ring: var(--color-admin-accent);",
    );
  });
});
