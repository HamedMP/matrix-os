import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CronJob } from "../cron/types.js";

export function buildHeartbeatPrompt(
  homePath: string,
  pendingEvents: CronJob[],
): string {
  const sections: string[] = [];

  sections.push("[HEARTBEAT] Periodic check-in. Current time: " + new Date().toISOString());

  const heartbeatPath = join(homePath, "agents", "heartbeat.md");
  if (existsSync(heartbeatPath)) {
    sections.push("\n" + readFileSync(heartbeatPath, "utf-8"));
  }

  if (pendingEvents.length > 0) {
    sections.push("\n## Pending Reminders\n");
    for (const event of pendingEvents) {
      sections.push(`- **${event.name}**: ${event.message}`);
      if (event.target?.channel) {
        sections.push(`  (deliver to ${event.target.channel}${event.target.chatId ? `:${event.target.chatId}` : ""})`);
      }
    }
    sections.push("\nRelay these reminders to the user through the appropriate channel.");
  }

  sections.push(
    "\nIf there is nothing to do, respond with HEARTBEAT_OK. Otherwise, take action on pending items.",
  );

  return sections.join("\n");
}
