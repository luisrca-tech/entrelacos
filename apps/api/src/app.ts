import type { ApiProblem, HealthResponse } from "@entrelacos/contracts";
import { Hono } from "hono";

export const app = new Hono();

app.get("/v1/health", (context) => {
  return context.json({
    status: "ok",
    service: "entrelacos-api",
  } satisfies HealthResponse);
});

app.notFound((context) => {
  context.header("Content-Type", "application/problem+json");
  return context.body(
    JSON.stringify({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    } satisfies ApiProblem),
    404,
  );
});
