import type { ApiProblem, HealthResponse } from "@entrelacos/contracts";
import { Hono } from "hono";
import { createAdminAccessHttpRouter } from "./adminAccessHttp";
import { type AuthHttpOptions, createAuthHttpRouter } from "./authHttp";
import { createDemoGuestGrantHttpRouter } from "./demoGuestGrant";
import { createDemoResetHttpRouter } from "./demoResetHttp";
import { createGuestGroupsHttpRouter } from "./guestGroupsHttp";
import { createHandoffHttpRouter } from "./handoffHttp";
import { createMessagesHttpRouter } from "./messagesHttp";
import {
  createObservabilityMiddleware,
  type ObservabilityOptions,
  type ObservabilityVariables,
} from "./observability";
import { createPublicGuestHttpRouter } from "./publicGuestHttp";
import { createReportsHttpRouter } from "./reportsHttp";
import { createRsvpHttpRouter } from "./rsvpHttp";
import { createSitesHttpRouter } from "./sitesHttp";
import { createSmsUsageHttpRouter } from "./smsUsageHttp";

export function createApp(
  options?: AuthHttpOptions,
  observability?: ObservabilityOptions,
) {
  const app = new Hono<{ Variables: ObservabilityVariables }>();
  app.use("*", createObservabilityMiddleware(observability));

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
    app.route("/", createGuestGroupsHttpRouter(options));
    app.route("/", createDemoGuestGrantHttpRouter(options));
    app.route("/", createDemoResetHttpRouter(options));
    app.route("/", createPublicGuestHttpRouter(options));
    app.route("/", createRsvpHttpRouter(options));
    app.route("/", createReportsHttpRouter(options));
    app.route("/", createMessagesHttpRouter(options));
    app.route("/", createSmsUsageHttpRouter(options));
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
