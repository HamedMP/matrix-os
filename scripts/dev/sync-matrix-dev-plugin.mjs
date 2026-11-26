#!/usr/bin/env node
// Builds the matrix-dev plugin's skills from the canonical copies in
// .agents/skills. A plugin is installed from its own directory, so links that
// point outside dev/matrix-dev would not survive installation; the plugin holds
// real copies and this script keeps them identical.
//
//   node scripts/dev/sync-matrix-dev-plugin.mjs           rewrite the copies
//   node scripts/dev/sync-matrix-dev-plugin.mjs --check   fail when they differ
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const canonicalSkillsDir = join(repoRoot, ".agents/skills");
export const pluginSkillsDir = join(repoRoot, "dev/matrix-dev/skills");

// The skills engineers get from the plugin. Add a name here, run this script,
// and commit the result to ship another skill.
export const MATRIX_DEV_SKILLS = [
  "daily-update",
  "monitor-stack-reviews",
  "release-full-stable",
  "release-matrix-stable",
  "release-notes",
  "release-platform",
  "unblock-tickets",
  "worktree-pr-monitor",
  "wrap-up",
];

async function listFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return files;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files.sort();
}

/** Returns one line per difference between the plugin copies and the canonical skills. */
export async function findDrift() {
  const drift = [];
  for (const name of MATRIX_DEV_SKILLS) {
    const source = join(canonicalSkillsDir, name);
    const target = join(pluginSkillsDir, name);
    const sourceFiles = (await listFiles(source)).map((file) => relative(source, file));
    const targetFiles = (await listFiles(target)).map((file) => relative(target, file));
    if (!sourceFiles.includes("SKILL.md")) {
      drift.push(`${name}: .agents/skills/${name}/SKILL.md is missing`);
      continue;
    }
    for (const file of sourceFiles) {
      if (!targetFiles.includes(file)) {
        drift.push(`${name}/${file}: missing from the plugin`);
      } else if (!(await readFile(join(source, file))).equals(await readFile(join(target, file)))) {
        drift.push(`${name}/${file}: differs from .agents/skills`);
      }
    }
    for (const file of targetFiles) {
      if (!sourceFiles.includes(file)) drift.push(`${name}/${file}: not in .agents/skills`);
    }
  }
  let shipped = [];
  try {
    shipped = (await readdir(pluginSkillsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  for (const name of shipped) {
    if (!MATRIX_DEV_SKILLS.includes(name)) drift.push(`${name}: in the plugin but not in MATRIX_DEV_SKILLS`);
  }
  return drift;
}

export async function syncPlugin() {
  await rm(pluginSkillsDir, { recursive: true, force: true });
  await mkdir(pluginSkillsDir, { recursive: true });
  for (const name of MATRIX_DEV_SKILLS) {
    await cp(join(canonicalSkillsDir, name), join(pluginSkillsDir, name), { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) {
    const drift = await findDrift();
    if (drift.length > 0) {
      console.error("matrix-dev plugin skills are out of date:");
      for (const line of drift) console.error(`  - ${line}`);
      console.error("Run: node scripts/dev/sync-matrix-dev-plugin.mjs");
      process.exit(1);
    }
    console.log(`matrix-dev plugin: ${MATRIX_DEV_SKILLS.length} skills in sync.`);
  } else {
    await syncPlugin();
    console.log(`matrix-dev plugin: wrote ${MATRIX_DEV_SKILLS.length} skills to dev/matrix-dev/skills.`);
  }
}
