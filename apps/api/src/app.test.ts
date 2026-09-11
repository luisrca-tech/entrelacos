import { apiProblemSchema, healthResponseSchema } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("API scaffold HTTP contract", () => {
  it("serves liveness without requiring database or provider credentials", async () => {
    const response = await app.request("/v1/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    const expected = {
      status: "ok",
      service: "entrelacos-api",
    };
    expect(healthResponseSchema.parse(body)).toEqual(expected);
    expect(body).toStrictEqual(expected);
  });

  it.each(["/v1/owner/sites", "/v1/admin/sites"])(
    "does not expose unimplemented route %s",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const body = await response.json();
      const expected = {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "NOT_FOUND",
      };
      expect(apiProblemSchema.parse(body)).toEqual(expected);
      expect(body).toStrictEqual(expected);
    },
  );

  it("does not accept writes on the liveness route", async () => {
    const response = await app.request("/v1/health", { method: "POST" });
    expect(response.status).toBe(404);
  });
});
