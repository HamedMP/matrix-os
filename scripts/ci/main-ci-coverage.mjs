#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  assertGitHubConfig,
  GITHUB_REQUEST_TIMEOUT_MS,
  MAX_GITHUB_RESPONSE_BYTES,
  requestGitHubJson,
} from "./github-actions-api.mjs";
import {
  assertCommitSha,
  EMPTY_TREE_SHA,
  isGitAncestor,
  MAX_CHANGED_PATHS,
  readGitChangedPaths,
} from "./git-coverage.mjs";

export { GITHUB_REQUEST_TIMEOUT_MS, MAX_GITHUB_RESPONSE_BYTES };
export const COVERAGE_RUN_PREFIX = "CI coverage-v1 · ";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function classifyMainCiChanges(changedPaths) {
  if (!Array.isArray(changedPaths)) {
    throw new Error("Changed paths must be an array");
  }
  if (changedPaths.length > MAX_CHANGED_PATHS) {
    throw new Error("Changed path count exceeds the limit");
  }
  let shouldRun = false;
  let docsContractTests = false;

  for (const path of changedPaths) {
    if (typeof path !== "string" || path.length > 4096 || /[\0\r\n]/.test(path)) {
      throw new Error("Changed path is invalid");
    }
    if (path.startsWith("docs/") || path.startsWith("specs/") || path.endsWith(".md")) {
      docsContractTests = true;
    } else {
      shouldRun = true;
    }
  }

  return { shouldRun, docsContractTests };
}

export async function selectCoverageFrontier(runs, targetSha, { isAncestor }) {
  for (const run of runs) {
    if (
      typeof run?.headSha !== "string" ||
      run.headSha === targetSha ||
      typeof run?.displayTitle !== "string" ||
      !run.displayTitle.startsWith(COVERAGE_RUN_PREFIX)
    ) {
      continue;
    }
    if (await isAncestor(run.headSha, targetSha)) {
      return run.headSha;
    }
  }
  return null;
}

export async function buildMainCiCoveragePlan(
  { targetSha, successfulRuns },
  { isAncestor, getEmptyTreeSha, getChangedPaths },
) {
  const frontier = await selectCoverageFrontier(successfulRuns, targetSha, { isAncestor });
  const baseSha = frontier ?? await getEmptyTreeSha();
  const changedPaths = await getChangedPaths(baseSha, targetSha);
  const decision = classifyMainCiChanges(changedPaths);

  return {
    baseSha,
    bootstrap: frontier === null,
    ...decision,
  };
}

export async function listSuccessfulCoverageRuns({ repository, token, fetchImpl = fetch }) {
  assertGitHubConfig(repository, token);

  const endpoint = `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100`;
  const body = await requestGitHubJson(endpoint, { token, fetchImpl });
  if (!Array.isArray(body?.workflow_runs)) {
    throw new Error("Main CI coverage history is invalid");
  }
  if (body.workflow_runs.length > 100) {
    throw new Error("Main CI coverage history exceeds the run limit");
  }
  return body.workflow_runs.flatMap((run) => {
    if (
      !Number.isSafeInteger(run?.id) ||
      typeof run?.head_sha !== "string" ||
      !SHA_PATTERN.test(run.head_sha) ||
      typeof run?.display_title !== "string"
    ) {
      return [];
    }
    return [{ id: run.id, headSha: run.head_sha, displayTitle: run.display_title }];
  });
}

export async function runMainCiCoverage({ repository, targetSha, token, fetchImpl = fetch }) {
  assertCommitSha(targetSha);
  const successfulRuns = await listSuccessfulCoverageRuns({ repository, token, fetchImpl });
  return buildMainCiCoveragePlan(
    { targetSha, successfulRuns },
    {
      isAncestor: async (candidate, target) => isGitAncestor(candidate, target),
      getEmptyTreeSha: async () => EMPTY_TREE_SHA,
      getChangedPaths: async (base, target) => readGitChangedPaths(base, target),
    },
  );
}

async function main() {
  const plan = await runMainCiCoverage({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    targetSha: process.env.GITHUB_SHA ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  process.stderr.write(
    `main-ci-coverage: base=${plan.baseSha} bootstrap=${plan.bootstrap} source=${plan.shouldRun} docs=${plan.docsContractTests}\n`,
  );
  process.stdout.write([
    `base_sha=${plan.baseSha}`,
    `bootstrap=${plan.bootstrap}`,
    `should_run=${plan.shouldRun}`,
    `docs_contract_tests=${plan.docsContractTests}`,
    "",
  ].join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown main CI coverage failure";
    process.stderr.write(`main-ci-coverage: ${message}\n`);
    process.exitCode = 1;
  });
}
