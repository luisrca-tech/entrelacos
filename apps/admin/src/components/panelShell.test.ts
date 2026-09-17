import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(import.meta.dirname, "Panel.tsx"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(import.meta.dirname, "../routes/sites.$siteId.tsx"),
  "utf8",
);

describe("admin shell safety regressions", () => {
  it("guards load-more against concurrent requests and pending create", () => {
    expect(panelSource).toContain("loadingMoreRef.current");
    expect(panelSource).toContain("disabled={pending || loadingMore}");
  });

  it("redirects only the compatibility parent path", () => {
    expect(routeSource).toContain("location.pathname");
    expect(routeSource).toContain("if (pathname === parentPath)");
  });
});
