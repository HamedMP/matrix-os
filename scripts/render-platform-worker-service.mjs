#!/usr/bin/env node

import { readFileSync } from "node:fs";

const workerName = process.argv[2];
if (!workerName || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName)) {
  throw new Error("Expected a valid Cloud Run worker service name");
}

const revision = JSON.parse(readFileSync(0, "utf8"));
const sourceAnnotations = revision?.metadata?.annotations;
const sourceSpec = revision?.spec;
if (!sourceAnnotations || !sourceSpec || sourceSpec.containers?.length !== 1) {
  throw new Error("Expected a single-container Cloud Run candidate revision");
}
if (!sourceSpec.serviceAccountName || !sourceSpec.containers[0].image?.includes("@sha256:")) {
  throw new Error("Candidate must have a service account and immutable image digest");
}

const spec = structuredClone(sourceSpec);
const workerFlags = spec.containers[0].env?.filter((entry) => entry.name === "PLATFORM_BACKGROUND_WORKERS_ENABLED");
if (workerFlags?.length !== 1 || workerFlags[0].value !== "false") {
  throw new Error("Candidate must have background workers disabled");
}
workerFlags[0].value = "true";

const annotations = { ...sourceAnnotations };
delete annotations["run.googleapis.com/client-name"];
delete annotations["run.googleapis.com/client-version"];
delete annotations["run.googleapis.com/operation-id"];
annotations["autoscaling.knative.dev/minScale"] = "0";
annotations["autoscaling.knative.dev/maxScale"] = "1";
annotations["run.googleapis.com/cpu-throttling"] = "false";

const service = {
  apiVersion: "serving.knative.dev/v1",
  kind: "Service",
  metadata: {
    name: workerName,
    annotations: {
      "run.googleapis.com/ingress": "internal",
      "run.googleapis.com/minScale": "1",
      "run.googleapis.com/maxScale": "1",
    },
  },
  spec: {
    template: { metadata: { annotations }, spec },
    traffic: [{ latestRevision: true, percent: 100 }],
  },
};

process.stdout.write(`${JSON.stringify(service, null, 2)}\n`);
