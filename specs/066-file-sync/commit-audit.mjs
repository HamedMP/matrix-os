import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const tasksPath = join(scriptDir, "tasks.md");
const auditPath = join(scriptDir, "audit.md");
const statePath = join(scriptDir, ".audit-state.json");

const managedTaskIds = ["T011", "T013", "T022", "T023"];

function readText(path) {
  return readFileSync(path, "utf8");
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function runCommand(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeCommandOutput(result) {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!text) {
    return result.status === 0 ? "pass" : "failed with no output";
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (result.status === 0) {
    return lines.slice(-4).join(" | ");
  }

  return lines.slice(-8).join(" | ");
}

function countMetricUpdates(source, metricName) {
  const pattern = new RegExp(`\\b${escapeRegExp(metricName)}\\.(set|inc|dec)\\(`, "g");
  return Array.from(source.matchAll(pattern)).length;
}

function buildFindings(files) {
  const findings = [];

  const serverUsesFallbackSyncApp =
    files.server.includes('import { syncApp } from "./sync/routes.js";') &&
    files.server.includes('app.route("/api/sync", syncApp);') &&
    !files.server.includes("createSyncRoutes(");

  if (serverUsesFallbackSyncApp) {
    findings.push({
      severity: "high",
      tasks: ["T013", "T023"],
      summary:
        "The real gateway still mounts the fallback `syncApp` export, so `/api/sync/*` is disconnected in the running server.",
      evidence:
        "`packages/gateway/src/server.ts` imports `syncApp` and mounts `app.route(\"/api/sync\", syncApp)`, but never calls `createSyncRoutes(...)` with live deps.",
      action:
        "Wire `createSyncRoutes(...)` into `server.ts` with auth/user extraction, R2 client, DB adapter, and peer registry before treating Phase 2/US1 as complete.",
    });
  }

  const wsSubscribeHandled =
    files.server.includes('parsed.type === "sync:subscribe"') ||
    files.server.includes('case "sync:subscribe"');

  if (!wsSubscribeHandled) {
    findings.push({
      severity: "high",
      tasks: ["T022"],
      summary:
        "WebSocket sync events are implemented in isolation but not wired into the main gateway WebSocket handler.",
      evidence:
        "`packages/gateway/src/ws-message-schema.ts` accepts `sync:subscribe`, but `packages/gateway/src/server.ts` never handles that message, registers peers, or removes them on disconnect.",
      action:
        "Instantiate a shared peer registry in the gateway, handle `sync:subscribe`, and hook disconnect cleanup so `sync:change`, `sync:peer-join`, and `sync:peer-leave` can flow end-to-end.",
    });
  }

  const metricSource = [files.routes, files.server, files.wsEvents].join("\n");
  const manifestEntriesWrong = files.routes.includes(
    "syncManifestEntries.set({ user_id: userId }, result.committed);",
  );
  const manifestBytesUpdates = countMetricUpdates(metricSource, "syncManifestBytes");
  const connectedPeerUpdates = countMetricUpdates(metricSource, "syncConnectedPeers");

  if (manifestEntriesWrong || manifestBytesUpdates === 0 || connectedPeerUpdates === 0) {
    findings.push({
      severity: "medium",
      tasks: ["T011"],
      summary:
        "The metric definitions exist, but the live gauge updates do not match the spec yet.",
      evidence:
        "The current route code sets `sync_manifest_entries` to the committed batch size, and there are no live `.set()` calls for `sync_manifest_bytes` or `sync_connected_peers` in the runtime wiring.",
      action:
        "Update gauges from manifest metadata and peer-registry state, not from per-request batch counts, and wire peer-count updates into connect/disconnect paths.",
    });
  }

  return findings;
}

function upsertTaskNotes(taskContent, notesByTask) {
  let next = taskContent;

  for (const taskId of managedTaskIds) {
    const start = `<!-- audit:${taskId}:start -->`;
    const end = `<!-- audit:${taskId}:end -->`;
    const blockPattern = new RegExp(
      `\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`,
      "g",
    );
    next = next.replace(blockPattern, "\n");

    const note = notesByTask.get(taskId);
    if (!note) {
      continue;
    }

    const taskPattern = new RegExp(`(^- \\[[ xX]\\] ${taskId}[^\\n]*\\n)`, "m");
    const replacement = `$1${start}\n  Audit: ${note}\n${end}\n`;

    if (taskPattern.test(next)) {
      next = next.replace(taskPattern, replacement);
    }
  }

  return next.replace(/\n{3,}/g, "\n\n");
}

function buildAuditMarkdown({
  auditedAt,
  branch,
  headSha,
  headSubject,
  dirtyStatus,
  recentCommits,
  findings,
  gatewayTests,
  syncClientTests,
}) {
  const lines = [
    "# Audit: 066 File Sync",
    "",
    `- Last updated: \`${auditedAt}\``,
    `- Branch: \`${branch}\``,
    `- Head: \`${headSha.slice(0, 7)}\` ${headSubject}`,
    `- Worktree: ${dirtyStatus.length === 0 ? "clean" : "dirty"}`,
    "",
    "## Assessment",
    findings.length === 0
      ? "The current branch is aligned with the 066 spec, plan, and task sequencing based on the checks in this audit."
      : "The commit sequence is mostly aligned with the 066 plan: docs -> scaffold -> gateway foundation -> US1 red tests. The current drift is in runtime wiring, not feature direction, and it still blocks the Phase 2/US1 checkpoint.",
    "",
    "## Findings",
  ];

  if (findings.length === 0) {
    lines.push("- No blocking alignment gaps detected by the current audit rules.");
  } else {
    for (const finding of findings) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.tasks.join(", ")}: ${finding.summary}`,
        `  Evidence: ${finding.evidence}`,
        `  Action: ${finding.action}`,
      );
    }
  }

  lines.push(
    "",
    "## Test Status",
    `- \`pnpm test tests/gateway/sync\`: ${gatewayTests.status === 0 ? "pass" : "fail"} — ${summarizeCommandOutput(gatewayTests)}`,
    `- \`pnpm --dir packages/sync-client test\`: ${syncClientTests.status === 0 ? "pass" : "fail"} — ${summarizeCommandOutput(syncClientTests)}`,
    "",
    "## Recent 066 Commits",
  );

  if (recentCommits.length === 0) {
    lines.push("- No matching `066` commits found.");
  } else {
    for (const commit of recentCommits) {
      lines.push(`- \`${commit.sha}\` ${commit.subject}`);
    }
  }

  if (syncClientTests.status !== 0) {
    lines.push(
      "",
      "## Note",
      "The sync-client suite is still in the red phase for US2. That is acceptable if the next commits are implementing `manifest-cache`, `conflict-resolver`, and `sync-engine`, but Phase 4 should not outrun the missing US1 runtime wiring above.",
    );
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const auditedAt = new Date().toISOString();
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = runGit(["rev-parse", "HEAD"]);
  const headSubject = runGit(["log", "-1", "--pretty=%s"]);
  const dirtyStatusRaw = runGit(["status", "--short"]);
  const dirtyStatus = dirtyStatusRaw.length === 0 ? [] : dirtyStatusRaw.split("\n");

  const files = {
    server: readText(join(repoRoot, "packages/gateway/src/server.ts")),
    routes: readText(join(repoRoot, "packages/gateway/src/sync/routes.ts")),
    wsEvents: readText(join(repoRoot, "packages/gateway/src/sync/ws-events.ts")),
  };

  const findings = buildFindings(files);
  const notesByTask = new Map();

  for (const finding of findings) {
    for (const taskId of finding.tasks) {
      const current = notesByTask.get(taskId);
      const next = `${finding.summary} ${finding.action}`;
      notesByTask.set(taskId, current ? `${current} ${next}` : next);
    }
  }

  const gatewayTests = runCommand("pnpm", ["test", "tests/gateway/sync"]);
  const syncClientTests = runCommand("pnpm", ["--dir", "packages/sync-client", "test"]);

  const recentCommitLines = runGit([
    "log",
    "--oneline",
    "--decorate",
    "-n",
    "10",
    "--grep=(066)",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const recentCommits = recentCommitLines.map((line) => {
    const [sha, ...subjectParts] = line.split(" ");
    return { sha, subject: subjectParts.join(" ") };
  });

  const nextTasks = upsertTaskNotes(readText(tasksPath), notesByTask);
  writeFileSync(tasksPath, nextTasks, "utf8");

  const auditMarkdown = buildAuditMarkdown({
    auditedAt,
    branch,
    headSha,
    headSubject,
    dirtyStatus,
    recentCommits,
    findings,
    gatewayTests,
    syncClientTests,
  });
  writeFileSync(auditPath, auditMarkdown, "utf8");

  writeFileSync(
    statePath,
    `${JSON.stringify({ auditedAt, branch, headSha, findings: findings.length }, null, 2)}\n`,
    "utf8",
  );
}

if (!existsSync(tasksPath)) {
  throw new Error(`Missing tasks file: ${tasksPath}`);
}

main();
