#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LANES = Object.freeze(["platform", "shell", "edge", "runtime", "cli", "ops"]);
export const GIT_DIFF_TIMEOUT_MS = 30_000;

const LANE_ORDER = new Map(LANES.map((lane, index) => [lane, index]));

const DISPATCH_SELECTORS = Object.freeze({
  "deploy/platform": "platform",
  "deploy/shell": "shell",
  "deploy/edge": "edge",
  "deploy/runtime": "runtime",
  "deploy/cli": "cli",
  "deploy/ops": "ops",
});

const LABEL_SELECTORS = Object.freeze({
  "deploy-platform-preview": "platform",
  "deploy-shell-preview": "shell",
  "deploy-edge-preview": "edge",
  "preview-vps": "runtime",
});

const REQUIRED_CHECKS_BY_LANE = Object.freeze({
  platform: ["platform-smoke"],
  shell: ["react-doctor", "shell-smoke"],
  edge: ["edge-smoke"],
  runtime: ["host-bundle-smoke"],
  cli: ["cli-smoke"],
  ops: ["ops-smoke"],
});

const ROOT_WORKSPACE_METADATA = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]);

const PATH_RULES = Object.freeze([
  {
    test: (path) => ROOT_WORKSPACE_METADATA.has(path),
    lanes: LANES,
    reason: "root workspace metadata changed",
  },
  {
    test: (path) => path === "Dockerfile.platform" || path === "cloudbuild.platform.yaml",
    lanes: ["platform"],
    reason: "platform image build inputs changed",
  },
  {
    test: (path) => path === "scripts/start-platform-cloud-run.sh",
    lanes: ["platform"],
    reason: "platform Cloud Run startup changed",
  },
  {
    test: (path) => path === "scripts/build-host-bundle.sh" || path === "scripts/host-bundle-release.mjs",
    lanes: ["runtime"],
    reason: "host-bundle release tooling changed",
  },
  {
    test: (path) => path.startsWith("shell/"),
    lanes: ["shell", "runtime"],
    reason: "shell files changed",
  },
  {
    test: (path) => path.startsWith("packages/platform/") || path.startsWith("packages/clerk-sync/"),
    lanes: ["platform"],
    reason: "platform control-plane code changed",
  },
  {
    test: (path) => path.startsWith("packages/proxy/"),
    lanes: ["platform"],
    reason: "platform shared proxy package changed",
  },
  {
    test: (path) => path.startsWith("packages/ui/"),
    lanes: ["shell", "runtime"],
    reason: "shared UI package changed",
  },
  {
    test: (path) => path.startsWith("packages/gateway/src/integrations/"),
    lanes: ["platform", "runtime"],
    reason: "platform-mounted gateway integration code changed",
  },
  {
    test: (path) =>
      path.startsWith("packages/gateway/") ||
      path.startsWith("packages/kernel/") ||
      path.startsWith("packages/sync-client/"),
    lanes: ["runtime"],
    reason: "customer runtime package changed",
  },
  {
    test: (path) => path.startsWith("packages/edge-router/"),
    lanes: ["edge"],
    reason: "edge router package changed",
  },
  {
    test: (path) => path.startsWith("packages/observability/"),
    lanes: ["ops", "platform", "shell"],
    reason: "observability package changed",
  },
  {
    test: (path) =>
      path.startsWith("home/") ||
      path.startsWith("skills/") ||
      path.startsWith("distro/customer-vps/host-bin/") ||
      path.startsWith("distro/customer-vps/systemd/"),
    lanes: ["runtime"],
    reason: "host-bundle shipped files changed",
  },
  {
    test: (path) => path === "distro/customer-vps/cloud-init.yaml",
    lanes: ["platform"],
    reason: "customer VPS provisioning inputs changed",
  },
  {
    test: (path) => path.startsWith("distro/observability/"),
    lanes: ["ops"],
    reason: "observability ops files changed",
  },
]);

export function buildGitDiffArgs({ base, head }) {
  if (!base || !head) {
    throw new Error("Both --base and --head are required when --path is not provided");
  }
  return ["diff", "--name-only", `${base}..${head}`];
}

export function formatGitDiffFailure(args, result) {
  if (result.error instanceof Error) {
    return result.error.message || String(result.error);
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return stderr || `git ${args.join(" ")} failed`;
}

export function resolveLaneDecision({ changedPaths = [], selectors = [], labels = [], tags = [] } = {}) {
  const lanes = new Set();
  const requires = new Set();
  const reasonParts = [];
  const blocked = [];

  for (const selector of selectors) {
    const lane = DISPATCH_SELECTORS[selector];
    if (!lane) {
      throw new Error(`Unknown deploy selector: ${selector}`);
    }
    lanes.add(lane);
    reasonParts.push(`manual dispatch ${selector}`);
  }

  for (const label of labels) {
    const lane = LABEL_SELECTORS[label];
    if (lane) {
      lanes.add(lane);
      reasonParts.push(`label ${label}`);
    }
  }

  for (const tag of tags) {
    const lane = laneForTag(tag);
    lanes.add(lane);
    reasonParts.push(`tag ${tag}`);
  }

  for (const path of changedPaths) {
    const normalized = normalizePath(path);
    const rule = PATH_RULES.find((candidate) => candidate.test(normalized));
    if (!rule) {
      continue;
    }
    for (const lane of rule.lanes) {
      lanes.add(lane);
    }
    reasonParts.push(rule.reason);
  }

  for (const lane of lanes) {
    for (const required of REQUIRED_CHECKS_BY_LANE[lane] ?? []) {
      requires.add(required);
    }
  }

  const decision = {
    lanes: sortByLaneOrder([...lanes]),
    reason: unique(reasonParts).join("; ") || "no deployable surfaces changed",
    requires: sortRequires([...requires]),
    blocked,
  };

  validateLaneDecision(decision);
  return decision;
}

export function validateLaneDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("Lane decision must be an object");
  }
  if (!Array.isArray(decision.lanes)) {
    throw new Error("Lane decision must include a lanes array");
  }
  for (const lane of decision.lanes) {
    if (!LANES.includes(lane)) {
      throw new Error(`Invalid lane emitted by delivery router: ${lane}`);
    }
  }
  if (typeof decision.reason !== "string" || decision.reason.length === 0) {
    throw new Error("Lane decision must include a non-empty reason");
  }
  if (!Array.isArray(decision.requires)) {
    throw new Error("Lane decision must include a requires array");
  }
  if (!Array.isArray(decision.blocked)) {
    throw new Error("Lane decision must include a blocked array");
  }
  for (const entry of decision.blocked) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Array.isArray(entry.lanes) ||
      typeof entry.reason !== "string" ||
      typeof entry.action !== "string"
    ) {
      throw new Error("Invalid blocked entry emitted by delivery router");
    }
    for (const lane of entry.lanes) {
      if (!LANES.includes(lane)) {
        throw new Error(`Invalid blocked lane emitted by delivery router: ${lane}`);
      }
    }
  }
  return decision;
}

function laneForTag(tag) {
  if (/^runtime\//.test(tag)) {
    throw new Error("runtime/* tags are not valid until the runtime tag migration lands");
  }
  if (/^platform\/v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag)) return "platform";
  if (/^shell\/v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag)) return "shell";
  if (/^edge\/v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag)) return "edge";
  if (/^cli-v\d+\.\d+\.\d+$/.test(tag)) return "cli";
  if (/^v[\w.-]+$/.test(tag)) return "runtime";
  throw new Error(`Unknown deploy tag: ${tag}`);
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sortByLaneOrder(values) {
  return unique(values).sort((left, right) => LANE_ORDER.get(left) - LANE_ORDER.get(right));
}

function sortRequires(values) {
  return unique(values).sort((left, right) => {
    const leftLane = laneForRequiredCheck(left);
    const rightLane = laneForRequiredCheck(right);
    if (leftLane !== rightLane) {
      return leftLane - rightLane;
    }
    return left.localeCompare(right);
  });
}

function laneForRequiredCheck(check) {
  for (const [lane, checks] of Object.entries(REQUIRED_CHECKS_BY_LANE)) {
    if (checks.includes(check)) return LANE_ORDER.get(lane);
  }
  return Number.MAX_SAFE_INTEGER;
}

function unique(values) {
  return [...new Set(values)];
}

function parseArgs(argv) {
  const parsed = {
    base: "",
    head: "",
    paths: [],
    selectors: [],
    labels: [],
    tags: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") parsed.base = requireValue(argv, ++index, arg);
    else if (arg === "--head") parsed.head = requireValue(argv, ++index, arg);
    else if (arg === "--path") parsed.paths.push(requireValue(argv, ++index, arg));
    else if (arg === "--selector") parsed.selectors.push(requireValue(argv, ++index, arg));
    else if (arg === "--label") parsed.labels.push(requireValue(argv, ++index, arg));
    else if (arg === "--tag") parsed.tags.push(requireValue(argv, ++index, arg));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function readChangedPaths({ base, head, paths }) {
  if (paths.length > 0) {
    return paths;
  }
  if (!base && !head) {
    return [];
  }
  const args = buildGitDiffArgs({ base, head });
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_DIFF_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(formatGitDiffFailure(args, result));
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`Usage: node scripts/delivery/resolve-lanes.mjs [options]

Options:
  --base <sha>       Base SHA for git diff
  --head <sha>       Head SHA for git diff
  --path <path>      Changed path. Repeatable; skips git diff when present
  --selector <name>  Manual dispatch selector such as deploy/platform
  --label <name>     PR label. Repeatable
  --tag <name>       Git tag. Repeatable
`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changedPaths = readChangedPaths(args);
    const decision = resolveLaneDecision({
      changedPaths,
      selectors: args.selectors,
      labels: args.labels,
      tags: args.tags,
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery router failure";
    process.stderr.write(`resolve-lanes: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
