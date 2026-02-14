import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadSoul, loadIdentity, loadUser, loadBootstrap } from "./soul.js";
import { loadSkills, buildSkillsToc } from "./skills.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function buildSystemPrompt(homePath: string): string {
  const sections: string[] = [];

  // Base system prompt
  const systemPromptPath = join(homePath, "agents", "system-prompt.md");
  if (existsSync(systemPromptPath)) {
    sections.push(readFileSync(systemPromptPath, "utf-8"));
  } else {
    sections.push("You are the Matrix OS kernel.");
  }

  // SOUL -- personality and behavior (L0, always present)
  const soul = loadSoul(homePath);
  if (soul) {
    sections.push("\n## Soul\n");
    sections.push(soul);
  }

  // Identity -- AI's public face
  const identity = loadIdentity(homePath);
  if (identity) {
    sections.push("\n## Identity\n");
    sections.push(identity);
  }

  // User -- human profile
  const user = loadUser(homePath);
  if (user) {
    sections.push("\n## User\n");
    sections.push(user);
  }

  // Bootstrap -- first-run instructions (deleted after onboarding)
  const bootstrap = loadBootstrap(homePath);
  if (bootstrap) {
    sections.push("\n## First Run\n");
    sections.push(bootstrap);
    sections.push(
      "\nIMPORTANT: This is a fresh install. Follow the bootstrap instructions above. After onboarding is complete, delete ~/system/bootstrap.md.",
    );
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

  // Skills TOC
  const skills = loadSkills(homePath);
  if (skills.length > 0) {
    sections.push("\n## Available Skills\n");
    sections.push(buildSkillsToc(skills));
    sections.push(
      "\nTo use a skill, call the `load_skill` tool with the skill name. The full instructions will be loaded into context.",
    );
  }

  // Activity (last 20 lines -- capped for token budget)
  const activityPath = join(homePath, "system", "activity.log");
  sections.push("\n## Recent Activity\n");
  if (existsSync(activityPath)) {
    const content = readFileSync(activityPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const last20 = lines.slice(-20);
    sections.push(
      last20.length > 0 ? last20.join("\n") : "No recent activity.",
    );
  } else {
    sections.push("No recent activity.");
  }

  return sections.join("\n");
}
