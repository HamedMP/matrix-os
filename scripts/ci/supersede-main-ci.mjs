#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  assertGitHubConfig,
  requestGitHub,
  requestGitHubJson,
} from "./github-actions-api.mjs";
import { assertCommitSha, isGitAncestor } from "./git-coverage.mjs";

const ACTIVE_RUN_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export async function findSupersededMainCiRuns(runs, targetSha, { isAncestor }) {
  const superseded = [];

  for (const run of runs) {
    if (
      run?.event !== "push" ||
      !ACTIVE_RUN_STATUSES.has(run?.status) ||
      typeof run?.headSha !== "string" ||
      run.headSha === targetSha ||
      !Number.isSafeInteger(run?.id)
    ) {
      continue;
    }
    if (await isAncestor(run.headSha, targetSha)) {
      superseded.push({ id: run.id, headSha: run.headSha });
    }
  }

  return superseded;
}

export async function cancelSupersededMainCiRuns(runs, { cancelRun }) {
  let cancelled = 0;
  let alreadyCompleted = 0;

  for (const run of runs) {
    const outcome = await cancelRun(run.id);
    if (outcome === "cancelled") cancelled += 1;
    else if (outcome === "already_completed") alreadyCompleted += 1;
    else throw new Error("Main CI cancellation returned an invalid outcome");
  }

  return { cancelled, alreadyCompleted };
}

export async function supersedeMainCi(
  config,
  { listRuns, isAncestor, cancelRun },
) {
  const runs = await listRuns(config);
  const superseded = await findSupersededMainCiRuns(runs, config.targetSha, { isAncestor });
  const result = await cancelSupersededMainCiRuns(superseded, { cancelRun });
  return { selected: superseded.length, ...result };
}

export async function listActiveMainCiRuns({ repository, token, fetchImpl = fetch }) {
  assertGitHubConfig(repository, token);
  const endpoint = `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100`;
  const body = await requestGitHubJson(endpoint, { token, fetchImpl });
  if (!Array.isArray(body?.workflow_runs)) {
    throw new Error("Main CI queue response is invalid");
  }
  if (body.workflow_runs.length > 100) {
    throw new Error("Main CI queue response exceeds the run limit");
  }
  return body.workflow_runs.flatMap((run) => {
    if (
      !Number.isSafeInteger(run?.id) ||
      typeof run?.head_sha !== "string" ||
      !SHA_PATTERN.test(run.head_sha) ||
      typeof run?.event !== "string" ||
      typeof run?.status !== "string"
    ) {
      return [];
    }
    return [{
      id: run.id,
      headSha: run.head_sha,
      event: run.event,
      status: run.status,
    }];
  });
}

export async function cancelMainCiRun(
  runId,
  { repository, token, fetchImpl = fetch },
) {
  assertGitHubConfig(repository, token);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("Main CI run ID is invalid");
  }
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs/${runId}/cancel`;
  const response = await requestGitHub(endpoint, {
    token,
    fetchImpl,
    method: "POST",
    acceptedStatuses: [202, 409],
  });
  return response.status === 202 ? "cancelled" : "already_completed";
}

export async function runMainCiSupersession({ repository, targetSha, token, fetchImpl = fetch }) {
  assertCommitSha(targetSha);
  const config = { repository, targetSha, token, fetchImpl };
  return supersedeMainCi(config, {
    listRuns: () => listActiveMainCiRuns(config),
    isAncestor: async (candidate, target) => isGitAncestor(candidate, target),
    cancelRun: (runId) => cancelMainCiRun(runId, config),
  });
}

async function main() {
  const result = await runMainCiSupersession({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    targetSha: process.env.GITHUB_SHA ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  process.stdout.write(
    `Main CI supersession selected=${result.selected} cancelled=${result.cancelled} already_completed=${result.alreadyCompleted}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown main CI supersession failure";
    process.stderr.write(`main-ci-supersede: ${message}\n`);
    process.exitCode = 1;
  });
}
