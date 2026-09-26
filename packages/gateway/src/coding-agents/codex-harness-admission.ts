import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";

export interface CodingAgentProviderAdmission {
  isProviderEnabled(providerId: string): Promise<boolean>;
}

function savedHarnessForProvider(providerId: string): "claude" | "codex" | "pi" | "opencode" | null {
  switch (providerId) {
    case "claude":
    case "codex":
    case "pi":
    case "opencode":
      return providerId;
    default:
      return null;
  }
}

/** Saved owner intent is authoritative for supported direct coding-agent runs. */
export function createCodexHarnessAdmission({ homePath }: { homePath: string }): CodingAgentProviderAdmission {
  const configurationPath = join(resolve(homePath), "system/ai-providers/settings.json");
  return {
    async isProviderEnabled(providerId) {
      const harness = savedHarnessForProvider(providerId);
      if (!harness) return true; // Adapter registration still rejects unsupported providers.
      try {
        const config = await readSavedProviderSettingsConfiguration(configurationPath);
        if (!config) return true; // Before Settings is saved, retain the legacy runnable route.
        const saved = config.harnesses.filter((entry) => entry.harness === harness);
        return saved.length === 0 || saved.some((entry) => entry.enabled);
      } catch (error: unknown) {
        // A present but unreadable owner policy cannot authorize a new run.
        const reason = error instanceof SyntaxError ? "invalid_json" : "unreadable";
        console.warn("[coding-agents] Saved harness settings unavailable", reason);
        return false;
      }
    },
  };
}
