import {
  deriveGettingStartedSnapshot,
  emptyGettingStartedSnapshot,
  GETTING_STARTED_STEP_IDS,
  type GettingStartedResults,
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

/** The status reads behind Getting started; the popover and the Getting started app derive from the same results. */
export async function loadGettingStartedResults(
  api: Pick<ApiClient, "get" | "forRuntime">,
  signal?: AbortSignal,
): Promise<GettingStartedResults> {
  const options = signal ? { signal } : undefined;
  const platformApi = api.forRuntime("primary");
  const [github, integrations, agents, projects, chats, billing, providers] = await Promise.allSettled([
    api.get("/api/github/status", options),
    api.get("/api/integrations", options),
    api.get("/api/agents/credentials/status", options),
    api.get("/api/workspace/projects", options),
    api.get("/api/chats?limit=1", options),
    platformApi.get("/billing/status", options),
    api.get("/api/ai/provider-settings", options),
  ]);

  return { github, integrations, agents, projects, chats, billing, providers };
}

export async function loadGettingStartedSnapshot(
  api: Pick<ApiClient, "get" | "forRuntime">,
  signal?: AbortSignal,
): Promise<GettingStartedSnapshot> {
  return deriveGettingStartedSnapshot(await loadGettingStartedResults(api, signal));
}
