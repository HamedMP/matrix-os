import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";

export interface CodingAgentProviderAdmission {
  isProviderEnabled(providerId: string): Promise<boolean>;
}

/** Saved owner intent is authoritative for new Codex runs; observations remain display-only. */
export function createCodexHarnessAdmission({ homePath }: { homePath: string }): CodingAgentProviderAdmission {
  const configurationPath = join(resolve(homePath), "system/ai-providers/settings.json");
  return {
    async isProviderEnabled(providerId) {
      if (providerId !== "codex") return true;
      try {
        const config = await readSavedProviderSettingsConfiguration(configurationPath);
        if (!config) return true; // Before Settings is saved, retain the legacy runnable route.
        const saved = config.harnesses.filter((harness) => harness.harness === "codex");
        return saved.length === 0 || saved.some((harness) => harness.enabled);
      } catch (error: unknown) {
        // A present but unreadable owner policy cannot authorize a new Codex run.
        const reason = error instanceof SyntaxError ? "invalid_json" : "unreadable";
        console.warn("[coding-agents] Saved Codex settings unavailable", reason);
        return false;
      }
    },
  };
}
