#!/usr/bin/env node
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { brainRoot, readBoundedJson } from "./brain.mjs";
import { synchronizeBrain } from "./brain-sync.mjs";

// Installed under ROOT/.claude/skills/personal-brain/scripts/.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
try {
  const input = await readBoundedJson(process.stdin);
  if (!["SessionStart", "Stop", "PreCompact"].includes(input.hook_event_name) || input.stop_hook_active) process.exit(0);
  const cwd = typeof input.cwd === "string" ? await realpath(resolve(input.cwd)) : "";
  if (!cwd || relative(root, cwd).startsWith("..")) process.exit(0);
  const { config } = await brainRoot(root);
  let synchronized = false;
  if (config.autoSync === true) {
    try {
      await synchronizeBrain(root, input.hook_event_name === "SessionStart" ? "pull" : "push");
      synchronized = true;
    } catch (error) {
      console.warn("Brain sync is pending; local notes are preserved. Run the explicit sync command to inspect account access, a stale lock, or conflicting history.");
    }
  }
  if (input.hook_event_name === "SessionStart") {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `This project is your personal Brain. Read .claude/skills/personal-brain/SKILL.md and INDEX.md. Before finishing each Brain task, save useful new owner-provided ideas, decisions, people or commitments with evidence; skip transient requests and generated answers. GitHub sync: ${synchronized ? "current" : config.autoSync ? "pending" : "not configured"}. Hooks synchronize saved notes; refresh source integrations through the skill when asked.` } }));
  } else if (config.autoSync && !synchronized) {
    console.log(JSON.stringify({ systemMessage: "Brain notes are saved locally. GitHub sync is pending." }));
  }
} catch (error) {
  console.warn("Brain hook did not complete; inspect the pilot configuration. Existing notes are preserved.");
}
