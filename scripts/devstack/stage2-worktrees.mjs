#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalWorktree, inspectSource, projectSource } from "./source-projection.mjs";

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const syncScope = ["Git worktree source (filtered)"];
const keyPattern = /^[a-z][a-z0-9-]{0,28}$/;
const [configPath, action, ...args] = process.argv.slice(2);
const longTimeout = 105_000;

class CapacityError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(file, args, options = {}) {
  return (await exec(file, args, {
    encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024, ...options,
  })).stdout;
}

async function readJson(path, missing) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && missing !== undefined) return missing;
    throw error;
  }
}

async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function privateFile(path) {
  const info = await lstat(path);
  requireCondition(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077),
    "Stage 2 configuration must be a private, user-owned regular file.");
}

async function config() {
  requireCondition(isAbsolute(configPath), "An absolute operator configuration path is required.");
  await privateFile(configPath);
  const value = await readJson(configPath);
  requireCondition(typeof value.computer === "string" && keyPattern.test(value.computer) && isAbsolute(value.state) &&
    isAbsolute(value.repository) && isAbsolute(value.mutagen) && isAbsolute(value.flock) &&
    isAbsolute(value.guard) && isAbsolute(value.sshShim) && Array.isArray(value.slots) &&
    value.slots.length > 0 && value.slots.length <= 8, "Invalid Stage 2 configuration.");
  const origin = new URL(value.previewOrigin);
  requireCondition(origin.protocol === "https:" && origin.origin === value.previewOrigin,
    "A fixed HTTPS preview origin is required.");
  const used = new Set();
  const endpoints = new Set();
  const previews = new Set();
  for (const slot of value.slots) {
    requireCondition(typeof slot.id === "string" && keyPattern.test(slot.id) && !used.has(slot.id) &&
      /^(?:[a-z0-9-]+:\/src|\/[^\u0000]+)$/.test(slot.endpoint) && !endpoints.has(slot.endpoint) &&
      /^\/vm\/[a-z0-9-]+\/$/.test(slot.previewPath) && !previews.has(slot.previewPath),
    "Invalid or duplicate Stage 2 slot.");
    used.add(slot.id);
    endpoints.add(slot.endpoint);
    previews.add(slot.previewPath);
  }
  await mkdir(value.state, { mode: 0o700, recursive: true });
  const st = await lstat(value.state);
  requireCondition(st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077) &&
    await realpath(value.state) === value.state, "Unsafe Stage 2 state directory.");
  return value;
}

function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return command("/usr/bin/git", ["-C", root, ...args], { env: { ...env, GIT_OPTIONAL_LOCKS: "0" } });
}

async function worktrees(conf) {
  const raw = await git(conf.repository, "worktree", "list", "--porcelain", "-z");
  const paths = raw.split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
  return paths.slice(1).filter(path => isAbsolute(path));
}

async function worktreeIdentity(conf, worktree) {
  requireCondition((await worktrees(conf)).includes(worktree) && await canonicalWorktree(worktree) === worktree,
    "Choose a linked worktree from the enrolled repository.");
  const directory = (await git(worktree, "rev-parse", "--absolute-git-dir")).trim();
  return realpath(directory);
}

function slotIdentity(conf, slot) {
  return { endpoint: slot.endpoint, previewUrl: new URL(slot.previewPath, conf.previewOrigin).href };
}

function slotDirectory(conf, slot) {
  return join(conf.state, slot.id);
}

async function bindings(conf) {
  const entries = [];
  const used = new Set();
  for (const slot of conf.slots) {
    const item = await readJson(join(slotDirectory(conf, slot), "binding.json"), null);
    if (!item) continue;
    const identity = slotIdentity(conf, slot);
    requireCondition(item.computer === conf.computer && typeof item.worktree === "string" &&
      isAbsolute(item.worktree) && typeof item.gitDir === "string" && isAbsolute(item.gitDir) &&
      item.endpoint === identity.endpoint && item.previewUrl === identity.previewUrl &&
      !used.has(item.worktree), "An enrolled Stage 2 slot identity changed.");
    used.add(item.worktree);
    entries.push({ ...item, slot });
  }
  return entries;
}

function mutagen(conf, slot) {
  const env = {
    HOME: conf.state,
    PATH: `${conf.sshShim}:/usr/bin:/bin`,
    MUTAGEN_DATA_DIRECTORY: join(conf.state, "mutagen"),
  };
  return (args, timeout = 20_000) => command(conf.mutagen, ["sync", ...args], { env, timeout });
}

async function inspect(conf, slot) {
  const name = `matrix-stage2-${slot.id}`;
  const records = JSON.parse(await mutagen(conf, slot)(["list", "--template", "{{json .}}"]));
  const matches = records.filter(item => item.name === name);
  requireCondition(matches.length <= 1, "Multiple sessions claim this Stage 2 slot.");
  if (!matches.length) return null;
  const [item] = matches;
  const split = slot.endpoint.indexOf(":");
  const beta = split < 0
    ? item.beta.path === slot.endpoint
    : item.beta.host === slot.endpoint.slice(0, split) && item.beta.path === slot.endpoint.slice(split + 1);
  requireCondition(item.alpha.path === join(slotDirectory(conf, slot), "source") &&
    beta && item.mode === "one-way-safe", "Stage 2 sync endpoint or mode changed.");
  return item;
}

const remoteIgnores = [
  ".git", ".svn", ".hg", "node_modules", ".next", "dist", "coverage",
  ".cache", ".turbo", "next-env.d.ts", ".env", ".env.*",
  ".DS_Store", "*.pem", "*.key", "*.log",
];

async function session(conf, slot) {
  const existing = await inspect(conf, slot);
  if (existing) {
    if (existing.paused) await mutagen(conf, slot)(["resume", existing.identifier]);
    return existing.identifier;
  }
  await mutagen(conf, slot)([
    "create", "--no-global-configuration", "--name", `matrix-stage2-${slot.id}`,
    "--mode", "one-way-safe", "--symlink-mode", "portable",
    ...remoteIgnores.flatMap(ignore => ["--ignore", ignore]),
    join(slotDirectory(conf, slot), "source"), slot.endpoint,
  ], 45_000);
  const item = await inspect(conf, slot);
  requireCondition(item, "Mutagen did not return an enrolled session.");
  return item.identifier;
}

async function guard(conf, verb, slot, ...args) {
  try {
    return (await command(conf.guard, [verb, slot.id, ...args], { timeout: 38_000 })).trim();
  } catch (error) {
    if (error?.code === 78) throw new CapacityError("The isolated Stage 2 slot lacks resource headroom.");
    throw error;
  }
}

async function projection(conf, entry, force = false) {
  const directory = slotDirectory(conf, entry.slot);
  requireCondition(await worktreeIdentity(conf, entry.worktree) === entry.gitDir,
    "The enrolled Git worktree identity changed.");
  await mkdir(join(directory, "source"), { mode: 0o700, recursive: true });
  return projectSource({
    worktree: entry.worktree,
    destination: join(directory, "source"),
    statePath: join(directory, "projection.json"),
    force,
  });
}

async function locked(conf, verb, ...inputs) {
  try {
    return await command(conf.flock, [
      "--timeout", "105", join(conf.state, "worktree.lock"),
      process.execPath, self, configPath, "__locked", verb, ...inputs,
    ], { timeout: longTimeout + 5000 });
  } catch (error) {
    if (error?.code === 78) throw new CapacityError("The isolated Stage 2 slot lacks resource headroom.");
    throw error;
  }
}

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function ensureWatcher(conf, entry) {
  const file = join(slotDirectory(conf, entry.slot), "watcher.json");
  const previous = await readJson(file, {});
  if (previous.worktree === entry.worktree && running(previous.pid)) return;
  const child = spawn(process.execPath, [self, configPath, "__watch", entry.slot.id, entry.worktree], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  requireCondition(child.pid, "Could not start the worktree watcher.");
  await save(file, { pid: child.pid, worktree: entry.worktree });
}

async function watchSource(conf, slotId, worktree) {
  let pending;
  let active = false;
  const refresh = async () => {
    if (active) return;
    active = true;
    try {
      await locked(conf, "project", slotId, worktree);
    } catch {
      // The locked operation records projection errors for status and manual sync.
    } finally {
      active = false;
    }
  };
  const fileEvents = watch(worktree, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => void refresh(), 250);
  });
  fileEvents.on("error", () => fileEvents.close());
  setInterval(() => void refresh(), 12_000);
}

async function bySlot(conf, id, worktree) {
  const entry = (await bindings(conf)).find(item => item.slot.id === id && item.worktree === worktree);
  requireCondition(entry, "The worktree is not enrolled for this slot.");
  return entry;
}

async function enroll(conf, worktree) {
  const current = await bindings(conf);
  const previous = current.find(binding => binding.worktree === worktree);
  if (previous) return previous;
  const gitDir = await worktreeIdentity(conf, worktree);
  const slot = conf.slots.find(item => item.adopt === worktree &&
    !current.some(binding => binding.slot.id === item.id)) ??
    conf.slots.find(item => !item.adopt && !current.some(binding => binding.slot.id === item.id));
  requireCondition(slot, "No eligible isolated Stage 2 slot is available.");
  await guard(conf, "claim", slot);
  const directory = slotDirectory(conf, slot);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const item = { computer: conf.computer, worktree, gitDir, ...slotIdentity(conf, slot) };
  await save(join(directory, "binding.json"), item);
  return { ...item, slot };
}

async function repairConflicts(conf, entry, item) {
  const source = await inspectSource({ worktree: entry.worktree });
  const allowed = new Set(source.paths);
  const conflicts = item.conflicts ?? [];
  requireCondition(conflicts.length <= 32 && !item.excludedConflicts,
    "Too many source conflicts to reset safely.");
  const files = conflicts.map(({ root, alphaChanges, betaChanges }) => {
    const [alpha] = alphaChanges;
    const [beta] = betaChanges;
    requireCondition(allowed.has(root) && alphaChanges.length === 1 && betaChanges.length === 1 &&
      alpha.path === root && beta.path === root && alpha.new?.kind === "file" &&
      beta.new?.kind === "file" && /^[a-f0-9]{40}$/.test(beta.new.digest),
    "This source conflict needs manual review before reset.");
    return { path: root, digest: beta.new.digest };
  });
  const transaction = randomUUID();
  const sync = mutagen(conf, entry.slot);
  await sync(["pause", item.identifier]);
  try {
    await guard(conf, "repair", entry.slot, transaction, JSON.stringify(files));
    await sync(["resume", item.identifier]);
    await sync(["flush", item.identifier], 50_000);
    const verified = await inspect(conf, entry.slot);
    requireCondition(verified?.identifier === item.identifier && !verified.conflicts?.length &&
      verified.alpha.connected && verified.beta.connected && !verified.lastError &&
      !verified.beta.transitionProblems?.length, "The source reset did not converge.");
  } catch (error) {
    await sync(["pause", item.identifier]).catch(() => {});
    await guard(conf, "restore", entry.slot, transaction).finally(() => sync(["resume", item.identifier]));
    throw error;
  }
}

async function synchronize(conf, entry, verb) {
  const { slot } = entry;
  await guard(conf, "verify", slot);
  const directory = slotDirectory(conf, slot);
  const statusPath = join(directory, "status.json");
  const previous = await readJson(statusPath, { state: "registered" });
  const wasReady = entry.activated === true || previous.state === "ready";
  let activated = false;
  await save(statusPath, { state: "syncing" });
  try {
    if (verb === "reset") await guard(conf, "reset", slot);
    await projection(conf, entry, verb === "reset");
    await guard(conf, "activate", slot);
    activated = true;
    const id = await session(conf, slot);
    await mutagen(conf, slot)(["flush", id], 65_000);
    let item = await inspect(conf, slot);
    if (verb === "reset" && item?.identifier === id && item.conflicts?.length) {
      await repairConflicts(conf, entry, item);
      item = await inspect(conf, slot);
    }
    requireCondition(item?.identifier === id && item.alpha.connected && item.beta.connected &&
      !item.conflicts?.length && !item.lastError && !item.beta.transitionProblems?.length,
    "Stage 2 sync is disconnected or reports conflicts.");
    const previewUrl = await guard(conf, "preview", slot);
    requireCondition(previewUrl === new URL(slot.previewPath, conf.previewOrigin).href, "Unexpected preview route.");
    await ensureWatcher(conf, entry);
    const { slot: _slot, ...binding } = entry;
    if (!binding.activated) await save(join(directory, "binding.json"), { ...binding, activated: true });
    await save(statusPath, { state: "ready", previewUrl });
    return { previewUrl, syncScope };
  } catch (error) {
    const item = await inspect(conf, slot).catch(() => null);
    await save(statusPath, { state: item?.conflicts?.length ? "conflict" : "unavailable" });
    if (activated && !wasReady) {
      if (item && !item.paused) await mutagen(conf, slot)(["pause", item.identifier]);
      await guard(conf, "rollback", slot);
    }
    throw error;
  }
}

async function diff(conf, entry) {
  const eligible = await inspectSource({ worktree: entry.worktree });
  const eligiblePaths = new Set(eligible.paths);
  requireCondition(await worktreeIdentity(conf, entry.worktree) === entry.gitDir,
    "The enrolled Git worktree identity changed.");
  const result = await git(entry.worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames");
  const changes = [];
  const excluded = [];
  for (const value of result.split("\0").filter(Boolean).slice(0, 1000)) {
    const status = value.slice(0, 2);
    const path = value.slice(3);
    if (eligiblePaths.has(path) || status.includes("D")) changes.push({ path, status });
    else excluded.push(path);
  }
  return { changes, excluded };
}

async function execute(conf, verb, [computer, worktree, browser]) {
  const entries = await bindings(conf);
  if (verb === "list") return entries.map(({ computer, worktree }) => ({ computer, worktree }));
  if (verb === "discover") {
    const choices = await worktrees(conf);
    return choices.filter(path => !computer || path === computer)
      .slice(0, 100).map(path => ({ computer: conf.computer, worktree: path }));
  }
  requireCondition(computer === conf.computer && isAbsolute(worktree) && resolve(worktree) === worktree,
    "Select the enrolled Dev Computer and worktree.");
  if (verb === "enroll") {
    const entry = await enroll(conf, worktree);
    const result = await synchronize(conf, entry, verb);
    if (browser === "open") await guard(conf, "open", entry.slot);
    return result;
  }
  const entry = entries.find(binding => binding.worktree === worktree);
  requireCondition(entry, "Enroll the worktree with matrix devstack first.");
  if (verb === "diff") return diff(conf, entry);
  if (verb === "status") {
    const recorded = await readJson(join(slotDirectory(conf, entry.slot), "status.json"), { state: "registered" });
    if (recorded.state !== "ready") return recorded;
    const item = await inspect(conf, entry.slot);
    if (item?.conflicts?.length) return { state: "conflict" };
    const watcher = await readJson(join(slotDirectory(conf, entry.slot), "watcher.json"), {});
    if (!item?.alpha.connected || !item.beta.connected || item.paused || item.lastError ||
        watcher.worktree !== entry.worktree || !running(watcher.pid)) return { state: "unavailable" };
    const previewUrl = await guard(conf, "preview", entry.slot).catch(() => null);
    return previewUrl === recorded.previewUrl ? recorded : { state: "unavailable" };
  }
  requireCondition(["connect", "sync", "reset"].includes(verb), "Unsupported Stage 2 operation.");
  const result = await synchronize(conf, entry, verb);
  if (verb === "connect" && browser === "open") await guard(conf, "open", entry.slot);
  return result;
}

async function main() {
  const conf = await config();
  if (action === "__watch") {
    await watchSource(conf, ...args);
  } else if (action === "__locked") {
    if (args[0] === "project") {
      const entry = await bySlot(conf, args[1], args[2]);
      try {
        await projection(conf, entry);
      } catch (error) {
        await save(join(slotDirectory(conf, entry.slot), "status.json"), { state: "unavailable" });
        throw error;
      }
    } else {
      console.log(JSON.stringify(await execute(conf, args[0], args.slice(1))));
    }
  } else if (["list", "discover", "diff", "status"].includes(action)) {
    console.log(JSON.stringify(await execute(conf, action, args)));
  } else {
    process.stdout.write(await locked(conf, action, ...args));
  }
}

main().catch(error => {
  console.error(error instanceof Error && !("cmd" in error) ? error.message : "Stage 2 operation failed.");
  process.exitCode = error instanceof CapacityError ? 78 : 1;
});
