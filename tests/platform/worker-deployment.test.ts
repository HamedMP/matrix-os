import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCleanupError, removeLegacyPlatformWorkerTags } from "../../scripts/ci/remove-legacy-platform-worker-tags.mjs";

const renderer = resolve("scripts/render-platform-worker-service.mjs");
const tagSelector = resolve("scripts/select-legacy-platform-worker-tags.mjs");
const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");

const candidate = {
  metadata: {
    name: "matrix-platform-candidate",
    annotations: {
      "autoscaling.knative.dev/maxScale": "30",
      "autoscaling.knative.dev/minScale": "0",
      "run.googleapis.com/cpu-throttling": "false",
      "run.googleapis.com/startup-cpu-boost": "true",
    },
  },
  spec: {
    containerConcurrency: 80,
    timeoutSeconds: 3600,
    serviceAccountName: "platform@example.iam.gserviceaccount.com",
    containers: [{
      image: "europe-west3-docker.pkg.dev/project/repo/platform@sha256:" + "a".repeat(64),
      resources: { limits: { cpu: "2", memory: "2Gi" } },
      env: [
        { name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "false" },
        { name: "ACCOUNT_DELETION_CONFIGURED", value: "false" },
        { name: "ACCOUNT_DELETION_ENABLED", value: "false" },
        { name: "PLATFORM_DATABASE_URL", valueFrom: { secretKeyRef: { name: "platform-database-url", key: "latest" } } },
      ],
    }],
  },
};

function render(source: unknown = candidate) {
  return spawnSync(process.execPath, [renderer, "matrix-platform-worker"], {
    input: JSON.stringify(source),
    encoding: "utf8",
  });
}

describe("platform worker deployment", () => {
  it("renders a private singleton worker from the exact candidate revision", () => {
    const result = render();
    expect(result.status).toBe(0);
    const service = JSON.parse(result.stdout);
    expect(service.metadata).toEqual({
      name: "matrix-platform-worker",
      annotations: {
        "run.googleapis.com/ingress": "internal",
        "run.googleapis.com/maxScale": "1",
        "run.googleapis.com/minScale": "1",
      },
    });
    expect(service.spec.traffic).toEqual([{ latestRevision: true, percent: 100 }]);
    expect(service.spec.template.metadata.annotations).toMatchObject({
      "autoscaling.knative.dev/maxScale": "1",
      "autoscaling.knative.dev/minScale": "0",
      "run.googleapis.com/cpu-throttling": "false",
    });
    expect(service.spec.template.spec).toMatchObject({
      containerConcurrency: 80,
      timeoutSeconds: 3600,
      serviceAccountName: candidate.spec.serviceAccountName,
    });
    const container = service.spec.template.spec.containers[0];
    expect(container.image).toBe(candidate.spec.containers[0].image);
    expect(container.resources).toEqual(candidate.spec.containers[0].resources);
    expect(container.env).toContainEqual({ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "true" });
    expect(container.env).toContainEqual({ name: "ACCOUNT_DELETION_ENABLED", value: "false" });
    expect(container.env).toContainEqual(candidate.spec.containers[0].env[3]);
  });

  it("keeps configured deletion processing active while API admission is disabled", () => {
    const source = structuredClone(candidate);
    source.spec.containers[0].env[1].value = "true";
    const result = render(source);
    expect(result.status).toBe(0);
    const worker = JSON.parse(result.stdout);
    expect(worker.spec.template.spec.containers[0].env).toContainEqual({
      name: "ACCOUNT_DELETION_ENABLED",
      value: "true",
    });
  });

  it("rejects a source revision already running background workers", () => {
    const source = structuredClone(candidate);
    source.spec.containers[0].env[0].value = "true";
    const result = render(source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("background workers disabled");
  });

  it("allocates worker CPU independently of a request-throttled web candidate", () => {
    const source = structuredClone(candidate);
    source.metadata.annotations["run.googleapis.com/cpu-throttling"] = "true";
    const result = render(source);
    expect(result.status).toBe(0);
    const worker = JSON.parse(result.stdout);
    expect(worker.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]).toBe("false");
    expect(worker.spec.template.spec.containers[0].image).toBe(source.spec.containers[0].image);
    expect(worker.spec.template.spec.containers[0].env).toContainEqual({ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "true" });
  });

  it("selects only idle tagged revisions that still start background workers", () => {
    const service = { status: { traffic: [
      { tag: "legacy-worker", revisionName: "old", percent: 0 },
      { tag: "current-web", revisionName: "web", percent: 100 },
      { tag: "safe-preview", revisionName: "safe", percent: 0 },
      { tag: "old-default-worker", revisionName: "default", percent: 0 },
      { tag: "serving-worker", revisionName: "serving", percent: 100 },
      { tag: "cold-preview", revisionName: "cold", percent: 0 },
    ] } };
    const revision = (name: string, flag: string | undefined, minScale: string) => ({
      metadata: { name, annotations: { "autoscaling.knative.dev/minScale": minScale } },
      spec: { containers: [{ env: flag ? [{ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: flag }] : [] }] },
    });
    const revisions = [revision("old", "true", "1"), revision("web", "false", "1"), revision("safe", "false", "1"), revision("default", undefined, "1"), revision("serving", "true", "1"), revision("cold", "true", "0")];
    const result = spawnSync(process.execPath, [tagSelector], {
      input: JSON.stringify({ service, revisions }), encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("legacy-worker,old-default-worker");
  });

  it("keeps web workers disabled and restores one worker before promotion", () => {
    expect(workflow.includes("PLATFORM_MAX_INSTANCES: '30'")).toBe(true);
    expect(workflow.includes("render-platform-worker-service.mjs")).toBe(true);
    expect(workflow.includes("Verify dedicated platform worker")).toBe(true);
    expect(workflow.includes("PLATFORM_BACKGROUND_WORKERS_ENABLED=false,CUSTOMER_VPS_IMAGE_VERSION")).toBe(true);
    expect(workflow.includes('"PLATFORM_BACKGROUND_WORKERS_ENABLED=false"')).toBe(true);
    expect(workflow.indexOf("Verify dedicated platform worker")).toBeLessThan(workflow.indexOf("- name: Promote revision"));
    expect(workflow.indexOf("- name: Promote revision")).toBeLessThan(workflow.indexOf("Remove legacy worker tags"));
  });

  it("keeps legacy worker cleanup scoped to tagged revisions", () => {
    const cleanup = workflow.slice(workflow.indexOf("- name: Remove legacy worker tags"));
    expect(cleanup).not.toContain("gcloud run revisions list");
    expect(cleanup).toContain("run: node scripts/ci/remove-legacy-platform-worker-tags.mjs");
    expect(workflow).toContain('      - "scripts/ci/remove-legacy-platform-worker-tags.mjs"');
  });

  it("rejects an unexpectedly large tagged revision set before querying revisions", () => {
    const traffic = Array.from({ length: 101 }, (_, index) => ({
      tag: `tag-${index}`, revisionName: `revision-${index}`, percent: 0,
    }));
    const execute = (_command: string, args: string[]) => {
      if (args[1] === "services" && args[2] === "describe") return JSON.stringify({ status: { traffic } });
      throw new Error("Unexpected revision lookup");
    };
    expect(() => removeLegacyPlatformWorkerTags({ CLOUD_RUN_SERVICE: "matrix-platform", GCP_PROJECT_ID: "matrix-test",
      GCP_REGION: "europe-west3", PRODUCTION_REVISION: "production-r1" }, execute))
      .toThrow("Too many tagged Cloud Run revisions");
  });

  it("reports bounded gcloud stderr when a revision lookup fails", () => {
    const service = { status: { traffic: [
      { tag: "legacy-worker", revisionName: "legacy-r1", percent: 0 },
      { revisionName: "production-r1", percent: 100 },
    ] } };
    const execute = (_command: string, args: string[]) => {
      if (args[1] === "services") return JSON.stringify(service);
      throw Object.assign(new Error("gcloud exited with status 1"), {
        stderr: `permission denied for revision legacy-r1 ${"detail ".repeat(1000)}`,
      });
    };
    let failure: unknown;
    try {
      removeLegacyPlatformWorkerTags({ CLOUD_RUN_SERVICE: "matrix-platform", GCP_PROJECT_ID: "matrix-test",
        GCP_REGION: "europe-west3", PRODUCTION_REVISION: "production-r1" }, execute);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const report = formatCleanupError(failure);
    expect(report).toContain("Cloud Run revision describe failed");
    expect(report).toContain("permission denied for revision legacy-r1");
    expect(report.length).toBeLessThan(4500);
  });

  it("fetches only tagged idle revisions, removes warm workers and verifies production traffic", () => {
    const before = { status: { traffic: [
      { tag: "legacy-worker", revisionName: "legacy-r1", percent: 0 },
      { tag: "cold-preview", revisionName: "cold-r1", percent: 0 },
      { tag: "production", revisionName: "production-r1", percent: 100 },
    ] } };
    const after = { status: { traffic: before.status.traffic.filter((target) => target.tag !== "legacy-worker") } };
    const revision = (name: string, minScale: string, workers: string) => ({
      metadata: { name, annotations: { "autoscaling.knative.dev/minScale": minScale } },
      spec: { containers: [{ env: [{ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: workers }] }] },
    });
    const records = new Map([
      ["legacy-r1", revision("legacy-r1", "1", "true")],
      ["cold-r1", revision("cold-r1", "0", "true")],
    ]);
    let service = before;
    const calls: string[] = [];
    const execute = (_command: string, args: string[]) => {
      calls.push(args.slice(0, 3).join(" "));
      if (args[1] === "services" && args[2] === "describe") return JSON.stringify(service);
      if (args[1] === "revisions" && args[2] === "describe") {
        const row = records.get(args[3]!);
        if (!row) throw new Error("Unexpected revision lookup");
        return JSON.stringify(row);
      }
      if (args[1] === "services" && args[2] === "update-traffic") {
        expect(args.slice(-2)).toEqual(["--remove-tags", "legacy-worker"]);
        service = after;
        return "";
      }
      throw new Error(`Unexpected Cloud Run request: ${args.join(" ")}`);
    };

    expect(removeLegacyPlatformWorkerTags({ CLOUD_RUN_SERVICE: "matrix-platform", GCP_PROJECT_ID: "matrix-test",
      GCP_REGION: "europe-west3", PRODUCTION_REVISION: "production-r1" }, execute))
      .toEqual({ inspectedRevisions: 2, removedTags: 1 });
    expect(calls).toEqual([
      "run services describe",
      "run revisions describe",
      "run revisions describe",
      "run services update-traffic",
      "run services describe",
    ]);
  });

  it.each([
    ["tag removal was ineffective", [{ tag: "legacy-worker", revisionName: "legacy-r1", percent: 0 },
      { revisionName: "production-r1", percent: 100 }], /Warm legacy worker revisions remain tagged/],
    ["production traffic moved", [{ revisionName: "legacy-r1", percent: 50 },
      { revisionName: "production-r1", percent: 50 }], /Legacy tag cleanup changed production traffic/],
  ] as const)("fails closed when %s", (_scenario, afterTraffic, message) => {
    const before = { status: { traffic: [
      { tag: "legacy-worker", revisionName: "legacy-r1", percent: 0 },
      { revisionName: "production-r1", percent: 100 },
    ] } };
    let updated = false;
    const execute = (_command: string, args: string[]) => {
      if (args[1] === "services" && args[2] === "describe") {
        return JSON.stringify(updated ? { status: { traffic: afterTraffic } } : before);
      }
      if (args[1] === "revisions" && args[2] === "describe") return JSON.stringify({
        metadata: { name: "legacy-r1", annotations: { "autoscaling.knative.dev/minScale": "1" } },
        spec: { containers: [{ env: [{ name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "true" }] }] },
      });
      if (args[1] === "services" && args[2] === "update-traffic") { updated = true; return ""; }
      throw new Error("Unexpected Cloud Run request");
    };
    expect(() => removeLegacyPlatformWorkerTags({ CLOUD_RUN_SERVICE: "matrix-platform", GCP_PROJECT_ID: "matrix-test",
      GCP_REGION: "europe-west3", PRODUCTION_REVISION: "production-r1" }, execute)).toThrow(message);
    expect(updated).toBe(true);
  });
});
