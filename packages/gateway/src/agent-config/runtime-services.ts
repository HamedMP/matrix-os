import { createHermesRuntimeAdapter } from "./hermes-adapter.js";
import { createHermesRuntimeSource, type HermesJsonReader } from "./hermes-source.js";
import {
  createAgentRuntimeController,
  type AgentRuntimeController,
} from "./runtime-controller.js";
import type { AgentRuntimeSource } from "./service.js";

interface HermesRuntimeClient {
  readJson: HermesJsonReader;
  requestJson(
    path: string,
    init: Omit<RequestInit, "signal" | "redirect">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface HermesAgentRuntimeServices {
  source: AgentRuntimeSource;
  controller: AgentRuntimeController;
}

export function createHermesAgentRuntimeServices(options: {
  homePath: string;
  client: HermesRuntimeClient;
}): HermesAgentRuntimeServices {
  const source = createHermesRuntimeSource(options.client.readJson);
  const adapter = createHermesRuntimeAdapter({
    source,
    requestJson: options.client.requestJson,
  });
  const controller = createAgentRuntimeController({
    homePath: options.homePath,
    adapters: { hermes: adapter },
  });
  return { source, controller };
}
