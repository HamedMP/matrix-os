import { Redirect } from "expo-router";
import { AgentProjectRoute } from "@/components/agents/agent-project-route";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

export default function ProjectAgentRoute() {
  if (!CODING_AGENTS_MOBILE_WORKSPACE) return <Redirect href="/agents" />;
  return <AgentProjectRoute routeViewMode="conversation" />;
}
