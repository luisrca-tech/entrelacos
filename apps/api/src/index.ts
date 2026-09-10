import { serve } from "@hono/node-server";
import { app } from "./app";

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3001),
});

process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
