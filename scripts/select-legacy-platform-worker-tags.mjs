#!/usr/bin/env node

import { readFileSync } from "node:fs";

const { service, revisions } = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(service?.status?.traffic) || !Array.isArray(revisions)) {
  throw new Error("Expected Cloud Run service and revision list");
}

const byName = new Map(revisions.map((revision) => [revision?.metadata?.name, revision]));
const tags = [];
for (const target of service.status.traffic) {
  if (!target.tag || (target.percent ?? 0) > 0) continue;
  if (!/^[a-z][a-z0-9-]*$/.test(target.tag)) throw new Error("Invalid Cloud Run tag");
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

process.stdout.write(`${tags.join(",")}\n`);
