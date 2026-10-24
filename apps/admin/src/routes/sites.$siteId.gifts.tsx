import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/gifts")({
  component: SiteGiftsRoute,
});

function SiteGiftsRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="gifts" />;
}
