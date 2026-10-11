#!/usr/bin/env node
// Deployment-only binding/readback. Runtime membership authorization is unchanged.
import { spawnSync } from "node:child_process";

const setting = "MATRIX_INTERNAL_CLERK_ORG_ID";
const mode = process.argv[2] ?? "validate";

function configuredOrganization() {
  const value = process.env[setting];
  if (value === undefined || value === "") return undefined;
  // Same organization shape as private-preview-access.ts; deployment rejects
  // whitespace rather than silently normalizing an incorrectly configured value.
  if (!/^org_[A-Za-z0-9]{1,124}$/.test(value)) {
    throw new Error("Private Preview deployment organization setting is invalid.");
  }
  return value;
}

function verifyRevision(expected) {
  const revision = process.argv[3];
  const project = process.env.GCP_PROJECT_ID;
  const region = process.env.GCP_REGION;
  if (!revision || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(revision) || !project || !region) {
    throw new Error("Private Preview revision readback requires deployment coordinates.");
  }
  const result = spawnSync("gcloud", [
    "run", "revisions", "describe", revision,
    "--project", project, "--region", region, "--quiet", "--format=json",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  // Never relay gcloud output/errors: revision JSON can contain private settings.
  if (result.error || result.status !== 0) {
    throw new Error("Private Preview deployment revision readback failed.");
  }
  let matches;
  try {
    const document = JSON.parse(result.stdout);
    const containers = document.spec?.containers;
    if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0]?.env)) throw new Error();
    matches = containers[0].env.filter(entry => entry?.name === setting);
  } catch {
    throw new Error("Private Preview deployment revision configuration is invalid.");
  }
  if (expected === undefined ? matches.length !== 0
    : matches.length !== 1 || matches[0].value !== expected || matches[0].valueFrom !== undefined) {
    throw new Error("Private Preview deployment revision does not match the reviewed organization setting.");
  }
}

try {
  const organization = configuredOrganization();
  switch (mode) {
    case "validate":
      if (organization === undefined) {
        console.error("Private Preview disabled: MATRIX_INTERNAL_CLERK_ORG_ID is unset; Private Preview routes remain unavailable (503).");
      } else if (process.env.GITHUB_ACTIONS === "true") {
        // This protects subsequent output only. The workflow must supply the
        // setting through a privacy-safe source before the runner logs its
        // environment preamble; calling add-mask later cannot hide that preamble.
        process.stdout.write(`::add-mask::${organization}\n`);
      }
      break;
    case "env-bindings":
      if (organization !== undefined) process.stdout.write(`|${setting}=${organization}`);
      break;
    case "update-env-bindings":
      if (organization !== undefined) process.stdout.write(`,${setting}=${organization}`);
      break;
    case "remove-env-bindings":
      if (organization === undefined) process.stdout.write(`,${setting}`);
      break;
    case "verify-revision":
      verifyRevision(organization);
      break;
    default:
      throw new Error("Unknown Private Preview deployment mode.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Private Preview deployment configuration failed.");
  process.exitCode = 1;
}
