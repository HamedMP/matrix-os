#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_TAGGED_REVISIONS = 100;
const revisionNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

function taggedIdleTargets(service) {
  if (!Array.isArray(service?.status?.traffic)) {
    throw new Error("Expected Cloud Run service traffic");
  }
  const targets = [];
  for (const target of service.status.traffic) {
    if (!target.tag) continue;
    const percent = target.percent ?? 0;
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error("Invalid Cloud Run traffic percentage");
    }
    if (percent > 0) continue;
    if (!revisionNamePattern.test(target.tag)) throw new Error("Invalid Cloud Run tag");
    if (!revisionNamePattern.test(target.revisionName)) throw new Error("Invalid Cloud Run revision name");
    targets.push(target);
    if (targets.length > MAX_TAGGED_REVISIONS) throw new Error("Too many tagged Cloud Run revisions");
  }
  return targets;
}

export function taggedIdleRevisionNames(service) {
  return [...new Set(taggedIdleTargets(service).map((target) => target.revisionName))];
}

export function selectLegacyPlatformWorkerTags(service, revisions) {
  if (!Array.isArray(revisions)) throw new Error("Expected Cloud Run revision list");
  if (revisions.length > MAX_TAGGED_REVISIONS) throw new Error("Too many Cloud Run revisions");
  const byName = new Map(revisions.map((revision) => [revision?.metadata?.name, revision]));
  const tags = [];
  for (const target of taggedIdleTargets(service)) {
    const revision = byName.get(target.revisionName);
    if (!revision) throw new Error("Tagged Cloud Run revision is missing from the revision list");
    const minimum = Number(revision.metadata?.annotations?.["autoscaling.knative.dev/minScale"] ?? "0");
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error("Invalid revision minimum instances");
    if (minimum === 0) continue;
    const workerFlag = revision.spec?.containers?.[0]?.env?.find(
      (entry) => entry.name === "PLATFORM_BACKGROUND_WORKERS_ENABLED",
    )?.value;
    if (workerFlag !== "false") tags.push(target.tag);
  }
  return tags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { service, revisions } = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(`${selectLegacyPlatformWorkerTags(service, revisions).join(",")}\n`);
}
