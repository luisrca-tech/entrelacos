import { apiProblemSchema, healthResponseSchema } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("API scaffold HTTP contract", () => {
  it("serves liveness without requiring database or provider credentials", async () => {
    const response = await app.request("/v1/health");
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
      service: "entrelacos-api",
    });
  });

  it("does not expose unimplemented administrative routes", async () => {
    const response = await app.request("/v1/admin/sites");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "NOT_FOUND",
    );
  });

  it("does not accept writes on the liveness route", async () => {
    const response = await app.request("/v1/health", { method: "POST" });
    expect(response.status).toBe(404);
  });
});
