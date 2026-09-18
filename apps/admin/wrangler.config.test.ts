import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const configPath = resolve(import.meta.dirname, "wrangler.jsonc");

describe("Cloudflare Worker configuration", () => {
  it("preserves dashboard runtime variables across Wrangler deploys", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      keep_vars?: boolean;
      env?: { dev?: { name?: string } };
    };

    expect(config.keep_vars).toBe(true);
    expect(config.env?.dev?.name).toBe("admin-dev");
  });
});
