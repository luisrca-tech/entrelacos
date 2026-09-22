import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/$siteId/overview")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/sites/$siteId/guests",
      params: { siteId: params.siteId },
    });
  },
});
