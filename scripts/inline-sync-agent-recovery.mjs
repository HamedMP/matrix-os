#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [agentPath, recoveryLibraryPath] = process.argv.slice(2);
if (!agentPath || !recoveryLibraryPath) {
  throw new Error("usage: inline-sync-agent-recovery.mjs <agent> <recovery-library>");
}

const loaderPattern = /# BEGIN update recovery library loader[\s\S]*?# END update recovery library loader/;
const agent = await readFile(agentPath, "utf8");
const recoveryLibrary = (await readFile(recoveryLibraryPath, "utf8"))
  .replace(/^#![^\n]*\n/, "")
  .trim();
const matches = agent.match(new RegExp(loaderPattern.source, "g"));
if (matches?.length !== 1 || recoveryLibrary.length === 0) {
  throw new Error("sync-agent recovery source is invalid");
}

const expanded = agent.replace(
  loaderPattern,
  `# BEGIN inlined update recovery library\n${recoveryLibrary}\n# END inlined update recovery library`,
);
await writeFile(agentPath, expanded, "utf8");
