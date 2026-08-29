#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GIT_DIFF_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const MAX_CHANGED_PATHS = 10_000;
export const MAX_MATCHED_PATHS = 20;
export const MAX_DIAGNOSTIC_CHARS = 2_000;

const ROOT_DOCKER_INPUTS = Object.freeze([
  ".dockerignore",
  ".env.docker.example",
  ".npmrc",
  "Dockerfile",
  "Dockerfile.dev",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
]);

const EXACT_DOCKER_INPUTS = Object.freeze([
  ".github/workflows/docker-test.yml",
  "distro/cloudflared-dev-vps.yml",
  "distro/docker-dev-entrypoint.sh",
  "distro/init-postgres.sh",
  "distro/p10k.zsh",
  "distro/zshrc",
  "scripts/branch-dev.sh",
  "scripts/build-default-apps.mjs",
  "scripts/ci/docker-relevance.mjs",
  "scripts/fix-node-pty-perms.mjs",
  "scripts/sync-matrix-agent-skills.sh",
  "packages/sync-client/package.json",
]);

const DOCKER_INPUT_PREFIXES = Object.freeze([
  "distro/observability/",
  "home/",
  "packages/brand/",
  "packages/contracts/",
  "packages/gateway/",
  "packages/kernel/",
  "packages/mcp-browser/",
  "packages/observability/",
  "packages/sync-client/src/protocol/",
  "packages/ui/",
  "scripts/docker-test/",
  "shell/",
  "skills/",
]);

export function classifyDockerChanges(changedPaths = []) {
  if (!Array.isArray(changedPaths)) {
    throw new Error("Changed paths must be an array");
  }
  if (changedPaths.length > MAX_CHANGED_PATHS) {
    throw new Error(`Changed path count exceeds the ${MAX_CHANGED_PATHS} path limit`);
  }

  const matchedPaths = [];
  for (const path of changedPaths) {
    const normalized = normalizePath(path);
    if (!normalized || !isDockerRelevantPath(normalized)) {
      continue;
    }
    if (matchedPaths.length < MAX_MATCHED_PATHS && !matchedPaths.includes(normalized)) {
      matchedPaths.push(normalized);
    }
  }

  if (matchedPaths.length > 0) {
    return {
      shouldRun: true,
      reason: "Docker/local-runtime inputs changed",
      matchedPaths,
    };
  }

  return {
    shouldRun: false,
    reason: "no Docker/local-runtime inputs changed",
    matchedPaths: [],
  };
}

export function readChangedPaths(
  { base = "", head = "", commit = "" } = {},
  { spawnGit = spawnSync } = {},
) {
  const args = buildGitArgs({ base, head, commit });
  const result = spawnGit("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_DIFF_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${formatGitFailure(args, result)}`);
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const paths = stdout.split("\0").filter(Boolean);

  if (paths.length > MAX_CHANGED_PATHS) {
    throw new Error(`Git returned more than ${MAX_CHANGED_PATHS} changed paths`);
  }
  return paths;
}

export function formatGitFailure(args, result) {
  if (result.error instanceof Error) {
    return truncateDiagnostic(result.error.message || String(result.error));
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return truncateDiagnostic(stderr || `git ${args.join(" ")} failed`);
}

function buildGitArgs({ base, head, commit }) {
  if (commit) {
    if (base || head) {
      throw new Error("--commit cannot be combined with --base or --head");
    }
    validateGitRef(commit, "--commit");
    return ["show", "--pretty=", "--name-only", "--no-renames", "-z", commit, "--"];
  }

  if (!base || !head) {
    throw new Error("Both --base and --head are required for a git diff");
  }
  validateGitRef(base, "--base");
  validateGitRef(head, "--head");
  return ["diff", "--name-only", "--no-renames", "-z", `${base}..${head}`, "--"];
}

function validateGitRef(ref, flag) {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    /[\0\r\n]/.test(ref)
  ) {
    throw new Error(`${flag} contains an invalid git revision`);
  }
}

function normalizePath(path) {
  if (typeof path !== "string") {
    throw new Error("Every changed path must be a string");
  }
  if (path.length > 4_096 || /[\0\r\n]/.test(path)) {
    throw new Error("Changed path contains invalid characters or exceeds 4096 characters");
  }
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

function isDockerRelevantPath(path) {
  if (ROOT_DOCKER_INPUTS.includes(path) || EXACT_DOCKER_INPUTS.includes(path)) {
    return true;
  }
  if (/^docker-compose(?:\.[^/]+)?\.ya?ml$/.test(path)) {
    return true;
  }
  if (/^distro\/docker-compose\.(?:local|multi)\.ya?ml$/.test(path)) {
    return true;
  }
  return DOCKER_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function truncateDiagnostic(message) {
  const normalized = String(message).replace(/[\r\n]+/g, " ").trim();
  if (normalized.length <= MAX_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

function parseArgs(argv) {
  const parsed = {
    base: "",
    head: "",
    commit: "",
    paths: [],
    format: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") parsed.base = requireValue(argv, ++index, arg);
    else if (arg === "--head") parsed.head = requireValue(argv, ++index, arg);
    else if (arg === "--commit") parsed.commit = requireValue(argv, ++index, arg);
    else if (arg === "--path") parsed.paths.push(requireValue(argv, ++index, arg));
    else if (arg === "--format") parsed.format = requireValue(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.paths.length > MAX_CHANGED_PATHS) {
    throw new Error(`--path may be repeated at most ${MAX_CHANGED_PATHS} times`);
  }
  if (parsed.format !== "json" && parsed.format !== "github") {
    throw new Error("--format must be either json or github");
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function resolveChangedPaths(args) {
  const hasPaths = args.paths.length > 0;
  const hasGitSource = Boolean(args.base || args.head || args.commit);
  if (hasPaths && hasGitSource) {
    throw new Error("--path cannot be combined with git revision arguments");
  }
  if (hasPaths) {
    return args.paths;
  }
  if (!hasGitSource) {
    throw new Error("Provide --path, --commit, or both --base and --head");
  }
  return readChangedPaths(args);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/ci/docker-relevance.mjs [options]

Change source (choose one):
  --base <ref> --head <ref>  Classify paths changed across a git range
  --commit <ref>             Classify paths changed by one commit
  --path <path>              Classify an explicit path; repeatable

Output:
  --format json              Emit the decision as JSON (default)
  --format github            Emit should_run=true|false for GITHUB_OUTPUT
`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const decision = classifyDockerChanges(resolveChangedPaths(args));
    const matches = decision.matchedPaths.length > 0 ? `: ${decision.matchedPaths.join(", ")}` : "";
    process.stderr.write(`docker-relevance: ${decision.reason}${matches}\n`);
    if (args.format === "github") {
      process.stdout.write(`should_run=${decision.shouldRun}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown classifier failure";
    process.stderr.write(`docker-relevance: ${truncateDiagnostic(message)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
