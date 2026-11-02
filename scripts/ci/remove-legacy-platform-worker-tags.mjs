#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  selectLegacyPlatformWorkerTags,
  taggedIdleRevisionNames,
} from "../select-legacy-platform-worker-tags.mjs";

const GCLOUD_TIMEOUT_MS = 60_000;
const GCLOUD_MAX_BUFFER = 8 * 1024 * 1024;
const SAFE_CLOUD_RUN_ID = /^[a-z][a-z0-9-]{0,127}$/;

function cloudRunId(value, label) {
  if (!value || !SAFE_CLOUD_RUN_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function callGcloud(args, action, execute) {
  try {
    return execute("gcloud", args, {
      encoding: "utf8",
      timeout: GCLOUD_TIMEOUT_MS,
      maxBuffer: GCLOUD_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error?.code === "ETIMEDOUT" ? "timed out"
      : error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "exceeded output limit"
      : "failed";
    throw new Error(`Cloud Run ${action} ${detail}`, { cause: error });
  }
}

function readCloudRunJson(args, action, execute) {
  const output = callGcloud(args, action, execute);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Cloud Run ${action} returned invalid JSON`, { cause: error });
  }
}

export function removeLegacyPlatformWorkerTags(env = process.env, execute = execFileSync) {
  const serviceName = cloudRunId(env.CLOUD_RUN_SERVICE, "Cloud Run service");
  const project = cloudRunId(env.GCP_PROJECT_ID, "GCP project");
  const region = cloudRunId(env.GCP_REGION, "GCP region");
  const productionRevision = cloudRunId(env.PRODUCTION_REVISION, "production revision");
  const location = ["--project", project, "--region", region];
  const describeService = () => readCloudRunJson(
    ["run", "services", "describe", serviceName, ...location, "--format=json"],
    "service describe", execute,
  );

  const service = describeService();
  const revisions = taggedIdleRevisionNames(service).map((name) => readCloudRunJson(
    ["run", "revisions", "describe", name, ...location, "--format=json"],
    "revision describe", execute,
  ));
  const legacyTags = selectLegacyPlatformWorkerTags(service, revisions);
  if (legacyTags.length) {
    callGcloud(
      ["run", "services", "update-traffic", serviceName, ...location, "--remove-tags", legacyTags.join(",")],
      "tag removal", execute,
    );
  }

  const after = describeService();
  const remaining = selectLegacyPlatformWorkerTags(after, revisions);
  if (remaining.length) throw new Error(`Warm legacy worker revisions remain tagged: ${remaining.join(",")}`);
  if (!after.status.traffic.some((target) => target.revisionName === productionRevision && target.percent === 100)
    || after.status.traffic.some((target) => target.revisionName !== productionRevision && (target.percent ?? 0) > 0)) {
    throw new Error("Legacy tag cleanup changed production traffic");
  }
  return { inspectedRevisions: revisions.length, removedTags: legacyTags.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = removeLegacyPlatformWorkerTags();
    console.log(`Inspected ${result.inspectedRevisions} tagged revisions; removed ${result.removedTags} legacy worker tags.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Legacy worker tag cleanup failed");
    process.exitCode = 1;
  }
}
