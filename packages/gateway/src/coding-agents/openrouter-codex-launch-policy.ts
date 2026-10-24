import { z } from "zod/v4";
import type { AgentLaunchInput } from "../agent-launcher.js";
import { OPENROUTER_CODEX_MODEL_IDS } from "../ai-providers/model-catalog.js";
import { codexNativeEnvironment } from "../ai-providers/codex-native-environment.js";

export interface OpenRouterCodexLaunch {
  kind: "openrouter";
  codexHome: string;
  apiKey: string;
  credentialGeneration: string;
  model: (typeof OPENROUTER_CODEX_MODEL_IDS)[number];
  expectedHarnessInstanceId: string;
  expectedAccountId: string;
}

const LaunchSchema = z.object({
  kind: z.literal("openrouter"),
  codexHome: z.string().min(1).max(4096),
  apiKey: z.string().trim().min(1).max(4096),
  credentialGeneration: z.uuid(),
  model: z.enum(OPENROUTER_CODEX_MODEL_IDS),
  expectedHarnessInstanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  expectedAccountId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
}).strict();

export function openRouterCodexLaunchPolicy(
  input: AgentLaunchInput,
  environment: Record<string, string>,
) {
  if (input.agent !== "codex" || !input.runtimeHome || !input.providerEventPath
    || !input.openRouterCodex || input.nativeCodexSubscription) {
    throw new Error("OpenRouter Codex execution is unavailable");
  }
  const launch = LaunchSchema.parse(input.openRouterCodex);
  if (input.model !== undefined && input.model !== launch.model) {
    throw new Error("OpenRouter Codex execution is unavailable");
  }
  const env = codexNativeEnvironment(input.runtimeHome, environment, launch.codexHome);
  env.OPENROUTER_API_KEY = launch.apiKey;
  return { env, args: [] as string[], launch };
}
