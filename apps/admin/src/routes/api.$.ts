import { createFileRoute } from "@tanstack/react-router";
import { proxyApiRequest } from "../server/apiProxy";

function forward({ request }: { request: Request }) {
  return proxyApiRequest(request, {
    apiBaseUrl: process.env.API_BASE_URL ?? "",
    adminOrigin: process.env.ADMIN_ORIGIN ?? "",
  });
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: forward,
      HEAD: forward,
      POST: forward,
      PUT: forward,
      PATCH: forward,
      DELETE: forward,
      OPTIONS: forward,
    },
  },
});
