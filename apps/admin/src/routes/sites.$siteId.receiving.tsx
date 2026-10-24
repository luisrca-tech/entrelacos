import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/$siteId/receiving")({
  component: Outlet,
});
