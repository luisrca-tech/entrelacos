import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

function matches(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

function localMediaReferences(html: string): string[] {
  const references: string[] = [];
  const pattern =
    /<(?:img|video|source)\b[^>]*\b(?:src|poster)=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (
      value &&
      !/^(?:[a-z]+:|\/\/|#)/i.test(value) &&
      !value.startsWith("data:")
    ) {
      references.push(value);
    } else if (value?.startsWith("/")) {
      references.push(value);
    }
  }
  return references;
}

function emittedPath(htmlPath: string, reference: string): string {
  const clean = reference.split(/[?#]/, 1)[0] ?? reference;
  if (clean.startsWith("/")) return normalize(clean.slice(1));
  const relativeHtmlPath = htmlPath.replace(/^dist[\\/]/, "");
  return normalize(join(dirname(relativeHtmlPath), clean));
}

export function inspectPublicHtml(
  htmlPath: string,
  html: string,
  emittedFiles: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (!/<html\b[^>]*\blang=["']pt-BR["'][^>]*>/i.test(html)) {
    errors.push(`${htmlPath}: expected lang=pt-BR`);
  }

  const required = [
    ["canonical", /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi],
    ["robots", /<meta\b(?=[^>]*\bname=["']robots["'])[^>]*>/gi],
    ["og:image", /<meta\b(?=[^>]*\bproperty=["']og:image["'])[^>]*>/gi],
    ["twitter:image", /<meta\b(?=[^>]*\bname=["']twitter:image["'])[^>]*>/gi],
  ] as const;
  for (const [label, pattern] of required) {
    if (matches(html, pattern) !== 1) {
      errors.push(`${htmlPath}: expected exactly one ${label}`);
    }
  }

  for (const reference of localMediaReferences(html)) {
    const path = emittedPath(htmlPath, reference);
    if (!emittedFiles.has(path)) {
      errors.push(`${htmlPath}: emitted media is missing: ${path}`);
    }
  }
  return errors;
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

export function verifyPublicBuild(root: string): string[] {
  if (!existsSync(root)) return [`${root}: build output is missing`];
  const files = filesBelow(root);
  const emittedFiles = new Set(
    files.map((file) => normalize(relative(root, file))),
  );
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  if (htmlFiles.length === 0) return [`${root}: no emitted HTML found`];
  return htmlFiles.flatMap((file) =>
    inspectPublicHtml(
      normalize(relative(root, file)),
      readFileSync(file, "utf8"),
      emittedFiles,
    ),
  );
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const builds = [
    resolve(repositoryRoot, "apps/wedding-demo/dist"),
    resolve(repositoryRoot, "apps/template-fixture/dist"),
  ];
  const errors = builds.flatMap(verifyPublicBuild);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Public consumer build artifacts passed SEO and media gates");
  }
}
