import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function buildSystemPrompt(homePath: string): string {
  const sections: string[] = [];

  // Base system prompt
  const systemPromptPath = join(homePath, "agents", "system-prompt.md");
  if (existsSync(systemPromptPath)) {
    sections.push(readFileSync(systemPromptPath, "utf-8"));
  } else {
    sections.push("You are the Matrix OS kernel.");
  }

  // File system paths (absolute)
  sections.push("\n## File System\n");
  sections.push(
    `MATRIX_HOME: ${homePath}\nAll paths like ~/modules/, ~/system/, ~/apps/ resolve to MATRIX_HOME. Always use the absolute path when writing files.`,
  );

  // State summary
  const statePath = join(homePath, "system", "state.md");
  sections.push("\n## Current State\n");
  if (existsSync(statePath)) {
    sections.push(readFileSync(statePath, "utf-8"));
  } else {
    sections.push("State unavailable.");
  }

  // Modules
  const modulesPath = join(homePath, "system", "modules.json");
  sections.push("\n## Installed Modules\n");
  if (existsSync(modulesPath)) {
    try {
      const modules = JSON.parse(readFileSync(modulesPath, "utf-8"));
      if (Array.isArray(modules) && modules.length === 0) {
        sections.push("No modules installed yet.");
      } else {
        sections.push(JSON.stringify(modules, null, 2));
      }
    } catch {
      sections.push("No modules installed yet.");
    }
  } else {
    sections.push("No modules installed yet.");
  }

  // Knowledge TOC
  const knowledgePath = join(homePath, "agents", "knowledge");
  sections.push("\n## Knowledge Base\n");
  if (existsSync(knowledgePath)) {
    try {
      const files = readdirSync(knowledgePath).filter((f) =>
        f.endsWith(".md"),
      );
      if (files.length > 0) {
        sections.push(
          files.map((f) => `- ${f.replace(".md", "")}`).join("\n"),
        );
      } else {
        sections.push("No knowledge files yet.");
      }
    } catch {
      sections.push("No knowledge files yet.");
    }
  } else {
    sections.push("No knowledge files yet.");
  }

  // User profile
  const profilePath = join(homePath, "agents", "user-profile.md");
  sections.push("\n## User Profile\n");
  if (existsSync(profilePath)) {
    sections.push(readFileSync(profilePath, "utf-8"));
  } else {
    sections.push("No user profile configured.");
  }

  // Activity (last 50 lines)
  const activityPath = join(homePath, "system", "activity.log");
  sections.push("\n## Recent Activity\n");
  if (existsSync(activityPath)) {
    const content = readFileSync(activityPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const last50 = lines.slice(-50);
    sections.push(
      last50.length > 0 ? last50.join("\n") : "No recent activity.",
    );
  } else {
    sections.push("No recent activity.");
  }

  return sections.join("\n");
}
