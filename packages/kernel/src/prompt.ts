import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadSoul, loadIdentity, loadUser, loadBootstrap } from "./soul.js";
import { loadSkills, buildSkillsToc } from "./skills.js";
import { parseSetupPlan } from "./onboarding.js";
import { loadHandle } from "./identity.js";
import { listTasks } from "./ipc.js";
import type { MatrixDB } from "./db.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function buildSystemPrompt(homePath: string, db?: MatrixDB): string {
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

  // Bootstrap -- loaded early so handle nudge can check it
  const bootstrap = loadBootstrap(homePath);

  // Handle -- federated identity (@handle:matrix-os.com)
  const handle = loadHandle(homePath);
  if (handle.handle) {
    sections.push(`\nYou are @${handle.aiHandle}:matrix-os.com, the AI assistant for @${handle.handle}:matrix-os.com (${handle.displayName}).`);
  } else if (!bootstrap) {
    sections.push(
      "\nThis user hasn't set their handle yet. Ask them to choose a handle (username) and use the `set_handle` tool to save it.",
    );
  }

  // User -- human profile
  const user = loadUser(homePath);
  if (user) {
    sections.push("\n## User\n");
    sections.push(user);
  }
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

  // Onboarding progress (when mid-build)
  const setupPlan = parseSetupPlan(homePath);
  if (setupPlan && setupPlan.status === "building") {
    const total = setupPlan.apps.length;
    const done = setupPlan.built.length;
    const remaining = setupPlan.apps
      .filter((a) => !setupPlan.built.includes(a.name))
      .map((a) => a.name);
    sections.push("\n## Onboarding Progress\n");
    sections.push(`Building apps: ${done}/${total} complete.`);
    if (remaining.length > 0) {
      sections.push(`Remaining: ${remaining.join(", ")}`);
    }
    sections.push("Continue building the remaining apps from the setup plan.");
  }

  // Active processes (from DB)
  if (db) {
    const active = listTasks(db, { status: "in_progress" })
      .filter((t) => t.type === "kernel");
    if (active.length > 0) {
      sections.push("\n## Active Processes\n");
      sections.push(
        active.map((p) => {
          try {
            const input = JSON.parse(p.input);
            return `- ${input.message ?? "unknown task"}`;
          } catch {
            return `- ${p.id}`;
          }
        }).join("\n"),
      );
      if (active.length >= 3) {
        sections.push(
          "\nWARNING: 3+ kernels running. Prefer direct handling over sub-agent spawning to limit resource usage.",
        );
      }
    }
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
