#!/usr/bin/env node

import { readFileSync } from "node:fs";

const workerName = process.argv[2];
if (!workerName || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName)) {
  throw new Error("Expected a valid Cloud Run worker service name");
}
const flags = process.argv.slice(3);
if (flags.some((flag) => flag !== "--role-worker" && flag !== "--metal-scope")) {
  throw new Error("Unknown renderer option");
}
// --role-worker: PLATFORM_ROLE=worker runs the background workers and serves
// only /health. --metal-scope (preview only) narrows it to the metal passes.
const roleWorker = flags.includes("--role-worker");
const metalScope = flags.includes("--metal-scope");
if (metalScope && !roleWorker) {
  throw new Error("The metal scope requires the worker role");
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
spec.containers[0].env ??= [];
const environment = spec.containers[0].env;
// Only a preview revision, which carries neither the production
// background-worker flag nor the account deletion flags, gets the relaxation.
const previewRevision = environment.some((entry) => entry.name === "PLATFORM_PREVIEW" && entry.value === "true");
const relaxed = roleWorker && previewRevision;
if (metalScope && !previewRevision) {
  throw new Error("The metal scope is for preview revisions only");
}
const workerFlags = environment.filter((entry) => entry.name === "PLATFORM_BACKGROUND_WORKERS_ENABLED");
if (relaxed && workerFlags.length === 0) {
  environment.push({ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "true" });
} else {
  if (workerFlags.length !== 1 || workerFlags[0].value !== "false") {
    throw new Error("Candidate must have background workers disabled");
  }
  workerFlags[0].value = "true";
}
if (roleWorker) {
  if (environment.some((entry) => entry.name === "PLATFORM_ROLE")) {
    throw new Error("Candidate must not already set a platform role");
  }
  environment.push({ name: "PLATFORM_ROLE", value: "worker" });
  if (metalScope) {
    if (environment.some((entry) => entry.name === "PLATFORM_WORKER_SCOPE")) {
      throw new Error("Candidate must not already set a worker scope");
    }
    environment.push({ name: "PLATFORM_WORKER_SCOPE", value: "metal" });
  }
}

const accountDeletionConfigured = environment.filter(
  (entry) => entry.name === "ACCOUNT_DELETION_CONFIGURED",
);
if (relaxed && accountDeletionConfigured.length === 0) {
  // A preview revision carries no account deletion configuration.
} else if (
  accountDeletionConfigured.length !== 1 ||
  !["true", "false"].includes(accountDeletionConfigured[0].value)
) {
  throw new Error("Candidate must have an exact account deletion configuration flag");
} else if (accountDeletionConfigured[0].value === "true") {
  const accountDeletionEnabled = spec.containers[0].env?.filter(
    (entry) => entry.name === "ACCOUNT_DELETION_ENABLED",
  );
  if (
    accountDeletionEnabled?.length !== 1 ||
    !["true", "false"].includes(accountDeletionEnabled[0].value)
  ) {
    throw new Error("Configured account deletion requires an exact API enablement flag");
  }
  accountDeletionEnabled[0].value = "true";
}

const annotations = { ...sourceAnnotations };
delete annotations["run.googleapis.com/client-name"];
delete annotations["run.googleapis.com/client-version"];
delete annotations["run.googleapis.com/operation-id"];
// Ingress is a service-level setting; Cloud Run rejects it on a revision template.
delete annotations["run.googleapis.com/ingress"];
delete annotations["run.googleapis.com/ingress-status"];
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
