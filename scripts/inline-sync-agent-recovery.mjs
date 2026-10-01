#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [agentPath, recoveryPath, manifestPath, rejectionPath] = process.argv.slice(2);
if (!agentPath || !recoveryPath) throw new Error("usage: inline-sync-agent-recovery.mjs <agent> <recovery> [manifest] [rejection]");
let agent = await readFile(agentPath, "utf8");
for (const [kind, path] of [["recovery", recoveryPath], ["manifest", manifestPath], ["request rejection", rejectionPath]]) {
  const pattern = new RegExp(`# BEGIN update ${kind} library loader[\\s\\S]*?# END update ${kind} library loader`, "g");
  const matches = agent.match(pattern);
  if (!matches && !path) continue;
  if (!path || matches?.length !== 1) throw new Error("sync-agent helper loader is invalid");
  const library = (await readFile(path, "utf8")).replace(/^#![^\n]*\n/, "").trim();
  if (!library) throw new Error("sync-agent helper source is invalid");
  agent = agent.replace(pattern, () => `# BEGIN inlined update ${kind} library\n${library}\n# END inlined update ${kind} library`);
}
await writeFile(agentPath, agent, "utf8");
