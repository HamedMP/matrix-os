import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(container.env).toContainEqual(candidate.spec.containers[0].env[1]);
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
    const productionDeployment = workflow.split("- name: Deploy production-role revision")[1]?.split("\n      - name:")[0];
    const bindings = productionDeployment?.match(/--update-env-vars "([^"]+)"/)?.[1].split(",");
    expect(bindings).toContain("PLATFORM_BACKGROUND_WORKERS_ENABLED=false");
    expect(bindings).toContain("CUSTOMER_VPS_IMAGE_VERSION=${CUSTOMER_VPS_IMAGE_VERSION}");
    expect(bindings).toContain("MATRIX_INTERNAL_CLERK_ORG_ID=${MATRIX_INTERNAL_CLERK_ORG_ID}");
    for (const name of ["PLATFORM_BACKGROUND_WORKERS_ENABLED", "CUSTOMER_VPS_IMAGE_VERSION", "MATRIX_INTERNAL_CLERK_ORG_ID"]) {
      expect(bindings?.filter(binding => binding.startsWith(`${name}=`))).toHaveLength(1);
    }
    expect(workflow.includes('"PLATFORM_BACKGROUND_WORKERS_ENABLED=false"')).toBe(true);
    expect(workflow.indexOf("Verify dedicated platform worker")).toBeLessThan(workflow.indexOf("- name: Promote revision"));
    expect(workflow.indexOf("- name: Promote revision")).toBeLessThan(workflow.indexOf("Remove legacy worker tags"));
  });
});
