import {
  deriveGettingStartedSnapshot,
  emptyGettingStartedSnapshot,
  GETTING_STARTED_STEP_IDS,
  type GettingStartedSnapshot,
} from "@matrix-os/contracts";
import type { ApiClient } from "../../lib/api";

export {
  emptyGettingStartedSnapshot,
  GETTING_STARTED_STEP_IDS,
} from "@matrix-os/contracts";
export type {
  GettingStartedSnapshot,
  GettingStartedStep,
  GettingStartedStepId,
  GettingStartedStepStatus,
} from "@matrix-os/contracts";

export async function loadGettingStartedSnapshot(
  api: Pick<ApiClient, "get" | "forRuntime">,
  signal?: AbortSignal,
): Promise<GettingStartedSnapshot> {
  const options = signal ? { signal } : undefined;
  const platformApi = api.forRuntime("primary");
  const [github, integrations, agents, projects, chats, billing] = await Promise.allSettled([
    api.get("/api/github/status", options),
    api.get("/api/integrations", options),
    api.get("/api/agents/credentials/status", options),
    api.get("/api/workspace/projects", options),
    api.get("/api/chats?limit=1", options),
    platformApi.get("/billing/status", options),
  ]);

  return deriveGettingStartedSnapshot({ github, integrations, agents, projects, chats, billing });
}
