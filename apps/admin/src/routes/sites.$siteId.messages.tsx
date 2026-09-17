import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/messages")({
  component: SiteMessagesRoute,
});

function SiteMessagesRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="messages" />;
}
