import { describe, expect, it } from "vitest";
import { showcaseBuildEnvironment } from "./showcaseBuildEnvironment";

describe("reviewed showcase build environments", () => {
  it("enables only the authorized production Botanical tenant", () => {
    const env = showcaseBuildEnvironment("botanical", "production");
    expect(env).toMatchObject({
      APP_ENV: "production",
      PUBLIC_SITE_ID: "demo-wedding",
      PUBLIC_LIVE_DEMO_SITE_ID: "demo-wedding",
      PUBLIC_API_URL: "https://entrelacosapi-production.up.railway.app",
    });
  });
  it("keeps DEV sandbox and Letters without a live opt-in", () => {
    expect(
      showcaseBuildEnvironment("botanical", "development")
        .PUBLIC_LIVE_DEMO_SITE_ID,
    ).toBe("");
    for (const environment of ["development", "production"]) {
      expect(showcaseBuildEnvironment("letters", environment)).toMatchObject({
        PUBLIC_SITE_ID: "demo-wedding-cartas",
        PUBLIC_LIVE_DEMO_SITE_ID: "",
      });
    }
  });
  it("rejects unknown targets rather than defaulting to production", () => {
    expect(() => showcaseBuildEnvironment("botanical", "prod")).toThrow();
    expect(() => showcaseBuildEnvironment("unknown", "production")).toThrow();
  });
});
