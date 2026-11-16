import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { allowsLiveSite, liveDemoSiteIdsSql } from "./liveSitePolicy";

describe("explicit live site policy", () => {
  const production = {
    mode: "live" as const,
    applicationEnvironment: "production" as const,
  };
  it("allows regular production sites without opt-in", () => {
    expect(
      allowsLiveSite({ ...production, siteId: "real-site", isDemo: false }),
    ).toBe(true);
  });
  it("allows only the explicitly designated production showcase while keeping its demo marker", () => {
    const site = {
      ...production,
      siteId: "demo-wedding",
      isDemo: true,
      liveDemoSiteIds: ["demo-wedding"],
    };
    expect(allowsLiveSite(site)).toBe(true);
    expect(site.isDemo).toBe(true);
    expect(allowsLiveSite({ ...site, siteId: "other-demo" })).toBe(false);
    expect(allowsLiveSite({ ...site, liveDemoSiteIds: undefined })).toBe(false);
    expect(allowsLiveSite({ ...site, liveDemoSiteIds: [] })).toBe(false);
  });
  it("allows every listed showcase and no other demo", () => {
    const liveDemoSiteIds = ["demo-wedding", "demo-wedding-cartas"];
    for (const siteId of liveDemoSiteIds)
      expect(
        allowsLiveSite({
          ...production,
          siteId,
          isDemo: true,
          liveDemoSiteIds,
        }),
      ).toBe(true);
    expect(
      allowsLiveSite({
        ...production,
        siteId: "demo-other",
        isDemo: true,
        liveDemoSiteIds,
      }),
    ).toBe(false);
  });
  it.each(["development", "test"] as const)(
    "never grants live access in %s",
    (applicationEnvironment) => {
      for (const isDemo of [true, false])
        expect(
          allowsLiveSite({
            ...production,
            applicationEnvironment,
            siteId: "demo-wedding",
            isDemo,
            liveDemoSiteIds: ["demo-wedding"],
          }),
        ).toBe(false);
    },
  );
  it.each(["disabled", "sandbox"] as const)(
    "never grants %s access",
    (mode) => {
      expect(
        allowsLiveSite({
          ...production,
          mode,
          siteId: "demo-wedding",
          isDemo: true,
          liveDemoSiteIds: ["demo-wedding"],
        }),
      ).toBe(false);
    },
  );
  it.each([
    "",
    "demo-wedding,other-demo",
    " demo-wedding",
    "demo-wedding/other",
  ])("rejects malformed showcase IDs (%#)", (siteId) => {
    expect(
      allowsLiveSite({
        ...production,
        siteId,
        isDemo: true,
        liveDemoSiteIds: [siteId],
      }),
    ).toBe(false);
  });
});

describe("live showcase SQL parameter", () => {
  const dialect = new PgDialect();
  it("binds the showcase list as one text array parameter", () => {
    const query = dialect.sqlToQuery(
      liveDemoSiteIdsSql(["demo-wedding", "demo-wedding-cartas"]),
    );
    expect(query.sql).toBe("$1::text[]");
    expect(query.params).toEqual([["demo-wedding", "demo-wedding-cartas"]]);
  });
  it("binds an empty array when no showcase is configured", () => {
    const query = dialect.sqlToQuery(liveDemoSiteIdsSql(undefined));
    expect(query.sql).toBe("$1::text[]");
    expect(query.params).toEqual([[]]);
  });
  it("drops malformed IDs instead of binding them", () => {
    const query = dialect.sqlToQuery(
      liveDemoSiteIdsSql(["demo-wedding", " bad", "x/y"]),
    );
    expect(query.params).toEqual([["demo-wedding"]]);
  });
});
