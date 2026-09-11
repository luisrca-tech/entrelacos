import { createFileRoute } from "@tanstack/react-router";
import { AccessForm } from "../components/AccessForm";
export const Route = createFileRoute("/recover")({
  component: () => <AccessForm purpose="recovery" />,
});
