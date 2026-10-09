#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, rm, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brainRoot, isBrainNote, NOTE_DIRECTORIES, ROOT_NOTES } from "./brain.mjs";

const execute = promisify(execFile);
async function run(root, command, args) {
  const { stdout } = await execute(command, args, { cwd: root, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_PAGER: "cat" } });
  return stdout.trim();
}
async function githubRepository(repository) {
  return JSON.parse(await run(process.cwd(), "gh", ["api", `repos/${repository}`]));
}
async function verifiedRemote(root, config, repositoryInfo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) throw new Error("Configure a private GitHub repository first.");
  const info = await repositoryInfo(config.repository);
  if (info.private !== true || info.full_name?.toLowerCase() !== config.repository.toLowerCase()) throw new Error("Brain sync requires the selected private GitHub repository.");
  for (const args of [["remote", "get-url", "origin"], ["remote", "get-url", "--push", "origin"]]) {
    const remote = await run(root, "git", args);
    if (![info.clone_url, info.ssh_url].includes(remote)) throw new Error("Brain remote does not match the selected private repository.");
  }
  if (await run(root, "git", ["rev-parse", "--show-toplevel"]) !== root) throw new Error("The Brain must have its own repository.");
  if (await run(root, "git", ["branch", "--show-current"]) !== "main") throw new Error("Pilot synchronization uses the main branch.");
}

export async function configureSynchronization(input, repository) {
  const { root, config } = await brainRoot(input);
  const next = { ...config, repository, autoSync: true };
  await verifiedRemote(root, next, githubRepository);
  const temporary = join(root, ".brain", `config-${process.pid}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, join(root, ".brain", "config.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return { configured: true, repository };
}

export async function synchronizeBrain(input, mode, repositoryInfo = githubRepository) {
  if (!["pull", "push"].includes(mode)) throw new Error("Use pull or push.");
  const { root, config } = await brainRoot(input);
  const lockPath = join(root, ".brain", "sync.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another Brain sync is running; inspect a leftover lock after a crash.");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await verifiedRemote(root, config, repositoryInfo);
    const git = args => run(root, "git", args);
    if (mode === "pull") {
      if (await git(["status", "--porcelain"])) throw new Error("Local edits are present; push or review them before pulling.");
      await git(["fetch", "origin", "main"]);
      await git(["merge", "--ff-only", "origin/main"]);
      return { status: "pulled" };
    }
    if (await git(["diff", "--cached", "--name-only"])) throw new Error("Existing staged changes need review before Brain sync.");
    const paths = (await git(["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z", "--", ...ROOT_NOTES, ...NOTE_DIRECTORIES])).split("\u0000").filter(Boolean);
    if (paths.length > 5000) throw new Error("Pilot sync file cap reached.");
    const notes = [...new Set(paths)].filter(isBrainNote);
    for (const note of notes) {
      try {
        if (!(await lstat(join(root, note))).isFile()) throw new Error("Brain sync only accepts regular note files.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error; // A tracked deletion is valid.
      }
    }
    if (notes.length) {
      await git(["--literal-pathspecs", "add", "--", ...notes]);
      await git(["commit", "-m", "chore(brain): checkpoint notes"]);
    }
    await git(["fetch", "origin", "main"]);
    const pendingPaths = (await git(["log", "--format=", "--name-only", "origin/main..HEAD"])).split("\n").filter(Boolean);
    if (pendingPaths.some(path => !isBrainNote(path))) throw new Error("Pending commits include files outside Brain notes; review before publishing.");
    await git(["push", "origin", "HEAD:refs/heads/main"]);
    return { status: "pushed", checkpointed: notes.length };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, root, repository] = process.argv.slice(2);
    if (!root) throw new Error("Usage: brain-sync.mjs pull|push|configure ROOT [owner/repository]");
    console.log(JSON.stringify(mode === "configure" ? await configureSynchronization(root, repository) : await synchronizeBrain(root, mode)));
  } catch (error) {
    console.error(error instanceof Error && !error.message.startsWith("Command failed") ? error.message : "Brain synchronization failed; local notes are preserved. Check account access or conflicting history.");
    process.exitCode = 1;
  }
}
