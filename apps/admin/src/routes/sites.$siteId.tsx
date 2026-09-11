import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";
export const Route = createFileRoute("/sites/$siteId")({ component: SitePage });
function SitePage() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} />;
}
