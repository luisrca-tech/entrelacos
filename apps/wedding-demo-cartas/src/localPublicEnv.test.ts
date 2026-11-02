import { describe, expect, it } from "vitest";
import {
  astroCliCommand,
  LOCAL_PUBLIC_ENV,
  localPublicEnvPatch,
} from "./localPublicEnv";

describe("local public env fallback", () => {
  it("fills missing PUBLIC values only for astro dev without an env file", () => {
    expect(
      localPublicEnvPatch({
        command: "dev",
        hasEnvFile: false,
        current: {},
      }),
    ).toEqual(LOCAL_PUBLIC_ENV);
    expect(
      localPublicEnvPatch({
        command: "dev",
        hasEnvFile: false,
        current: { PUBLIC_API_URL: "http://localhost:9999" },
      }),
    ).toEqual({
      PUBLIC_ADMIN_ORIGIN: LOCAL_PUBLIC_ENV.PUBLIC_ADMIN_ORIGIN,
      PUBLIC_SITE_ID: LOCAL_PUBLIC_ENV.PUBLIC_SITE_ID,
    });
  });

  it("does not leak localhost defaults into builds, previews, or env-file setups", () => {
    const current = {};
    expect(
      localPublicEnvPatch({ command: "build", hasEnvFile: false, current }),
    ).toEqual({});
    expect(
      localPublicEnvPatch({ command: "preview", hasEnvFile: false, current }),
    ).toEqual({});
    expect(
      localPublicEnvPatch({ command: "dev", hasEnvFile: true, current }),
    ).toEqual({});
  });

  it("treats astro build as build even when other words are present", () => {
    expect(astroCliCommand(["node", "astro", "dev"])).toBe("dev");
    expect(astroCliCommand(["node", "astro", "build"])).toBe("build");
    expect(astroCliCommand(["node", "astro", "preview"])).toBe("preview");
  });
});
