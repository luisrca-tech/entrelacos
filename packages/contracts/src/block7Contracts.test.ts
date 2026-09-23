import { describe, expect, it } from "vitest";
import {
  block7EndpointPaths,
  demoResetInputSchema,
  demoResetResponseSchema,
} from "./index";

describe("Block 7 demo reset contracts", () => {
  it("accepts only the frozen reset dataset version", () => {
    expect(
      demoResetInputSchema.parse({ datasetVersion: "block7-demo-v1" }),
    ).toEqual({
      datasetVersion: "block7-demo-v1",
    });
    expect(() =>
      demoResetInputSchema.parse({
        datasetVersion: "block7-demo-v1",
        force: true,
      }),
    ).toThrow();
    expect(() =>
      demoResetInputSchema.parse({ datasetVersion: "other-version" }),
    ).toThrow();
  });

  it("freezes the reset route and response shape", () => {
    expect(block7EndpointPaths.ownerSiteDemoReset).toBe(
      "POST /v1/owner/sites/:siteId/demo/reset",
    );
    expect(
      demoResetResponseSchema.parse({
        siteId: "site-demo",
        datasetVersion: "block7-demo-v1",
        result: "RESET",
        resetAt: "2028-04-01T12:00:00.000Z",
        counts: { invitations: 5, guests: 10, messages: 1 },
      }),
    ).toMatchObject({ result: "RESET", counts: { invitations: 5 } });
  });
});
