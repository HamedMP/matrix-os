#!/usr/bin/env node
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OLDER_THAN_DAYS = 3;
const DEFAULT_IMAGE_UNTIL = "168h";
const DEFAULT_BUILDER_KEEP_STORAGE = "20GB";
const DEFAULT_MAX_DEPTH = 4;

export function isHostBundlePath(candidatePath) {
  const normalized = path.normalize(candidatePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  return parts.at(-2) === "dist" && parts.at(-1) === "host-bundle";
}

function isSkippableDirectory(name) {
  return name === ".git" || name === "node_modules" || name === ".next";
}

async function maybeRealpath(candidatePath) {
  try {
    return await realpath(candidatePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isInsideRoot(candidateRealpath, rootRealpath) {
  const relative = path.relative(rootRealpath, candidateRealpath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walkForHostBundles(root, rootRealpath, depth, results) {
  if (depth > DEFAULT_MAX_DEPTH) {
    return;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isSkippableDirectory(entry.name)) {
      continue;
    }

    const childPath = path.join(root, entry.name);
    const childRealpath = await maybeRealpath(childPath);
    if (!childRealpath || !isInsideRoot(childRealpath, rootRealpath)) {
      continue;
    }

    if (isHostBundlePath(childPath)) {
      results.push({ path: childPath, realpath: childRealpath });
      continue;
    }

    await walkForHostBundles(childPath, rootRealpath, depth + 1, results);
  }
}

export async function collectHostBundleCandidates({ roots, olderThanDays, now = new Date() }) {
  const cutoffMs = now.getTime() - olderThanDays * DAY_MS;
  const candidates = [];

  for (const root of roots) {
    const rootRealpath = await maybeRealpath(root);
    if (!rootRealpath) {
      continue;
    }

    const discovered = [];
    await walkForHostBundles(rootRealpath, rootRealpath, 0, discovered);

    for (const candidate of discovered) {
      if (!isHostBundlePath(candidate.path)) {
        continue;
      }
      const candidateStat = await stat(candidate.realpath);
      if (candidateStat.mtimeMs <= cutoffMs) {
        candidates.push({
          path: candidate.path,
          realpath: candidate.realpath,
          mtime: candidateStat.mtime,
          sizeBytes: candidateStat.size,
        });
      }
    }
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runHostBundleCleanup({
  roots,
  olderThanDays,
  now = new Date(),
  dryRun,
  logger = () => {},
}) {
  const candidates = await collectHostBundleCandidates({ roots, olderThanDays, now });
  const removed = [];

  for (const candidate of candidates) {
    logger(`${dryRun ? "Would remove" : "Removing"} ${candidate.path}`);
    if (!dryRun) {
      await rm(candidate.realpath, { recursive: true, force: true });
      removed.push(candidate);
    }
  }

  return { candidates, removed };
}

export function buildDockerCleanupPlan({
  includeDocker,
  pruneImages,
  pruneBuilder,
  imageUntil = DEFAULT_IMAGE_UNTIL,
  builderKeepStorage = DEFAULT_BUILDER_KEEP_STORAGE,
}) {
  if (!includeDocker) {
    return [];
  }

  const plan = [];
  if (pruneImages) {
    plan.push({
      command: "docker",
      args: ["image", "prune", "--all", "--force", "--filter", `until=${imageUntil}`],
    });
  }
  if (pruneBuilder) {
    plan.push({
      command: "docker",
      args: ["builder", "prune", "--all", "--force", "--keep-storage", builderKeepStorage],
    });
  }
  return plan;
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

export function parseArgs(argv, env = process.env) {
  const roots = [];
  const options = {
    dryRun: true,
    olderThanDays: DEFAULT_OLDER_THAN_DAYS,
    includeDocker: false,
    pruneImages: true,
    pruneBuilder: true,
    imageUntil: DEFAULT_IMAGE_UNTIL,
    builderKeepStorage: DEFAULT_BUILDER_KEEP_STORAGE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--apply":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--root":
        roots.push(argv[++index]);
        break;
      case "--worktrees-root":
        roots.push(argv[++index]);
        break;
      case "--older-than-days":
        options.olderThanDays = parseNumber(argv[++index], "--older-than-days");
        break;
      case "--docker":
        options.includeDocker = true;
        break;
      case "--skip-docker":
        options.includeDocker = false;
        break;
      case "--skip-images":
        options.pruneImages = false;
        break;
      case "--skip-builder":
        options.pruneBuilder = false;
        break;
      case "--image-until":
        options.imageUntil = argv[++index];
        break;
      case "--builder-keep-storage":
        options.builderKeepStorage = argv[++index];
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const home = env.HOME || homedir();
  return {
    ...options,
    roots: roots.length > 0 ? roots : [path.join(home, "matrix-os.worktrees")],
  };
}

function printHelp() {
  console.log(`Usage: node scripts/cleanup-local-artifacts.mjs [options]

Safely remove local build artifacts that can fill engineer or legacy compose hosts.
The script defaults to dry-run mode. Pass --apply to delete eligible artifacts.

Options:
  --apply                         Delete eligible artifacts
  --dry-run                       Print actions without deleting (default)
  --root <path>                   Approved root to scan; repeatable
  --worktrees-root <path>         Alias for --root
  --older-than-days <days>        Remove host bundles older than this (default: 3)
  --docker                        Also run Docker image and builder prune commands
  --skip-docker                   Do not run Docker cleanup (default)
  --skip-images                   Skip docker image prune
  --skip-builder                  Skip docker builder prune
  --image-until <duration>        Docker image prune age filter (default: 168h)
  --builder-keep-storage <size>   Docker builder cache floor (default: 20GB)
`);
}

async function runCommand(command, args, { dryRun, logger }) {
  logger(`${dryRun ? "Would run" : "Running"} ${[command, ...args].join(" ")}`);
  if (dryRun) {
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${code}`));
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const logger = (message) => console.log(message);
  const hostBundles = await runHostBundleCleanup({
    roots: options.roots,
    olderThanDays: options.olderThanDays,
    dryRun: options.dryRun,
    logger,
  });

  if (hostBundles.candidates.length === 0) {
    logger("No eligible host bundle artifacts found.");
  }

  const dockerPlan = buildDockerCleanupPlan(options);
  for (const command of dockerPlan) {
    await runCommand(command.command, command.args, { dryRun: options.dryRun, logger });
  }

  logger(
    `${options.dryRun ? "Dry run complete" : "Cleanup complete"}: ` +
      `${hostBundles.removed.length}/${hostBundles.candidates.length} host bundle directories removed.`,
  );
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "cleanup failed");
    process.exitCode = 1;
  });
}
