import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const safeModeAgentDef = {
  model: "claude-sonnet-4-5-20250929",
  maxTurns: 10,
  disallowedTools: ["agent"],
};

export function buildSafeModePrompt(homePath: string): string {
  const sections: string[] = [];

  sections.push("[SAFE MODE] Matrix OS is running in safe mode due to repeated failures.");
  sections.push("Your job is to diagnose the issue and restore normal operation.\n");

  sections.push("## Instructions\n");
  sections.push("1. Read system/activity.log for recent errors");
  sections.push("2. Check system/config.json for misconfigurations");
  sections.push("3. Verify modules in system/modules.json are valid");
  sections.push("4. If a config file is corrupt, restore defaults");
  sections.push("5. If a module caused the crash, disable it");
  sections.push("6. Report what you found and what you fixed");
  sections.push("7. Do NOT spawn sub-agents or modify kernel/gateway source\n");

  const logPath = join(homePath, "system", "activity.log");
  if (existsSync(logPath)) {
    try {
      const log = readFileSync(logPath, "utf-8");
      const lines = log.trim().split("\n");
      const recent = lines.slice(-20).join("\n");
      if (recent) {
        sections.push("## Recent Activity Log\n");
        sections.push("```");
        sections.push(recent);
        sections.push("```\n");
      }
    } catch { /* no log */ }
  }

  return sections.join("\n");
}
