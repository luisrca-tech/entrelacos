import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/$siteId")({
  beforeLoad: ({ location, params }) => {
    const pathname = location.pathname.replace(/\/+$/, "");
    const parentPath = `/sites/${encodeURIComponent(params.siteId)}`;
    if (pathname === parentPath) {
      throw redirect({
        to: "/sites/$siteId/guests",
        params: { siteId: params.siteId },
      });
    }
  },
});
