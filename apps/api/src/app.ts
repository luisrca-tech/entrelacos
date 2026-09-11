import type { ApiProblem, HealthResponse } from "@entrelacos/contracts";
import { Hono } from "hono";
import { createAdminAccessHttpRouter } from "./adminAccessHttp";
import { type AuthHttpOptions, createAuthHttpRouter } from "./authHttp";
import { createHandoffHttpRouter } from "./handoffHttp";
import { createSitesHttpRouter } from "./sitesHttp";

export function createApp(options?: AuthHttpOptions) {
  const app = new Hono();

  app.get("/v1/health", (context) => {
    return context.json({
      status: "ok",
      service: "entrelacos-api",
    } satisfies HealthResponse);
  });

  if (options) {
    app.route("/", createAuthHttpRouter(options));
    app.route("/", createAdminAccessHttpRouter(options));
    app.route("/", createSitesHttpRouter(options));
    app.route("/", createHandoffHttpRouter(options));
  }

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

  return app;
}

export const app = createApp();
