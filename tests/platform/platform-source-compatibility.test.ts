import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultServingRevision, validateCompatibilityManifest, verifyPlatformSourceCompatibility, verifyServingPlatformSource } from "../../scripts/ci/platform-source-compatibility.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = `sha256:${"a".repeat(64)}`;
const path = "packages/platform/src/routines.ts";
const service = { status: { traffic: [{ revisionName: "live-r1", percent: 100 }, { revisionName: "decoy-r1", tag: "latest", percent: 0 }] } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const manifestFor = (sourceSha: string, content = "reviewed live auth\n") => ({ version: 1, exceptions: [{ sourceSha, imageDigest: digest,
  preservedFiles: [{ path, sha256: hash(content) }] }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "platform-provenance-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main"); git("config", "user.name", "Provenance Test"); git("config", "user.email", "test@example.invalid");
  const put = (file: string, contents: string) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), contents); };
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  put(path, "base auth\n"); const base = commit("base");
  git("checkout", "-b", "live"); put(path, "reviewed live auth\n"); const live = commit("live auth fix");
  git("checkout", "main"); put("packages/platform/src/feature.ts", "new credit behavior\n"); const lost = commit("divergent candidate");
  const revision = { metadata: { name: "live-r1", labels: { "matrix-source-sha": live } }, status: { imageDigest: `registry.invalid/repo/image@${digest}` } };
  return { root, git, put, commit, base, live, lost, revision,
    verify: (manifest: unknown = { version: 1, exceptions: [] }, override: Record<string, unknown> = {}) =>
      verifyPlatformSourceCompatibility({ root, candidateSha: git("rev-parse", "HEAD"), manifest, service, revision, ...override }) };
}

describe("platform serving-source compatibility", () => {
  it("accepts normal verified ancestry with an immutable image", () => {
    const f = fixture(); f.git("merge", "--no-edit", "live");
    expect(f.verify()).toMatchObject({ mode: "ancestor", sourceSha: f.live, revisionName: "live-r1" });
  });

  it("rejects a divergent candidate that omits an already-live patch", () => {
    const f = fixture();
    expect(() => f.verify()).toThrow("not an ancestor or reviewed compatibility exception");
    expect(() => f.verify(manifestFor(f.live))).toThrow("does not preserve reviewed live source files");
  });

  it("accepts pinned squash content without requiring original feature ancestry", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); f.commit("squash compatible auth and credit changes");
    expect(() => f.git("merge-base", "--is-ancestor", f.live, f.git("rev-parse", "HEAD"))).toThrow();
    expect(f.verify(manifestFor(f.live))).toMatchObject({ mode: "reviewed-content", sourceSha: f.live });
    // A squash checkout may not have the original feature object at all.
    const unavailableSource = "f".repeat(40);
    const revision = structuredClone(f.revision); revision.metadata.labels["matrix-source-sha"] = unavailableSource;
    expect(f.verify(manifestFor(unavailableSource), { revision })).toMatchObject({ mode: "reviewed-content" });
  });

  it("does not let ancestry bypass a known live-content preservation record", () => {
    const f = fixture(); f.git("merge", "--no-edit", "live"); f.put(path, "base auth\n"); f.commit("accidentally revert live fix");
    expect(() => f.verify(manifestFor(f.live))).toThrow("does not preserve reviewed live source files");
  });

  it("rejects a different live image even when pinned source content is present", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); f.commit("preserve");
    const revision = structuredClone(f.revision); revision.status.imageDigest = `sha256:${"b".repeat(64)}`;
    expect(() => f.verify(manifestFor(f.live), { revision })).toThrow("differs from reviewed compatibility exception");
  });

  it("rejects stale candidate SHA, tracked changes, missing files and symlinks", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); const candidate = f.commit("preserve");
    expect(() => f.verify(manifestFor(f.live), { candidateSha: f.base })).toThrow("does not match deployment SHA");
    f.put(path, "dirty\n"); expect(() => f.verify(manifestFor(f.live))).toThrow("tracked changes");
    f.git("checkout", "--", path); f.git("rm", path); f.commit("remove");
    expect(() => f.verify(manifestFor(f.live))).toThrow("file verification failed");
    f.put("packages/platform/src/other.ts", "reviewed live auth\n");
    symlinkSync("other.ts", join(f.root, path)); f.commit("symlink");
    expect(() => f.verify(manifestFor(f.live))).toThrow("file verification failed");
    expect(candidate).not.toBe(f.base);
  });

  it("rejects unknown revision metadata rather than using service/latest labels", () => {
    const f = fixture(); f.git("merge", "--no-edit", "live");
    for (const revision of [
      { ...f.revision, metadata: { name: "decoy-r1", labels: f.revision.metadata.labels } },
      { ...f.revision, metadata: { name: "live-r1", labels: {} } },
      { ...f.revision, status: { imageDigest: "registry.invalid/image:latest" } },
      { ...f.revision, status: {} },
    ]) expect(() => f.verify(undefined, { revision })).toThrow("unknown source or immutable image");
  });

  it("reads only actual serving revision metadata through bounded describe calls", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n");
    f.put("specs/639-managed-model-selection/current-runtime-compatibility.json", JSON.stringify(manifestFor(f.live)));
    const candidate = f.commit("preserve with manifest");
    const calls: string[][] = [];
    const execute = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
      expect(command).toBe("gcloud"); expect(options.timeout).toBe(60_000); expect(options.maxBuffer).toBe(1024 * 1024); calls.push(args);
      if (args[1] === "services") return JSON.stringify({ ...service, metadata: { labels: { "matrix-source-sha": candidate } }, status: { ...service.status, latestReadyRevisionName: "decoy-r1" } });
      expect(args.slice(0, 4)).toEqual(["run", "revisions", "describe", "live-r1"]);
      return JSON.stringify(f.revision);
    };
    expect(verifyServingPlatformSource({ CLOUD_RUN_SERVICE: "platform", GCP_PROJECT_ID: "test-project", GCP_REGION: "europe-west3", GITHUB_SHA: candidate, GITHUB_WORKSPACE: f.root }, execute)).toMatchObject({ mode: "reviewed-content" });
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args[2] === "describe" && args.includes("--quiet"))).toBe(true);
  });

  it.each([
    ["empty", []], ["split", [{ revisionName: "a", percent: 50 }, { revisionName: "b", percent: 50 }]],
    ["ambiguous", [{ revisionName: "a", percent: 100 }, { revisionName: "b", percent: 100 }]],
    ["unresolved latest", [{ latestRevision: true, percent: 100 }]],
    ["invalid percentage", [{ revisionName: "a", percent: "100" }]],
    ["oversized", Array.from({ length: 257 }, () => ({ revisionName: "a", percent: 0 }))],
  ])("rejects %s traffic", (_name, traffic) => {
    expect(() => defaultServingRevision({ status: { traffic } })).toThrow();
  });

  it("bounds and validates untrusted JSON, exception count, hashes and paths", () => {
    expect(() => defaultServingRevision("{" )).toThrow("Invalid compatibility JSON");
    expect(() => defaultServingRevision(" ".repeat(1024 * 1024 + 1))).toThrow("size limit");
    for (const badPath of ["../packages/file.ts", "packages/../file.ts", "/packages/file.ts", "packages/x\\y.ts", "packages/a/file.txt"]) {
      const manifest = manifestFor("a".repeat(40)); manifest.exceptions[0]!.preservedFiles[0]!.path = badPath;
      expect(() => validateCompatibilityManifest(manifest)).toThrow("Invalid preserved source file");
    }
    const manifest = manifestFor("a".repeat(40));
    expect(() => validateCompatibilityManifest({ ...manifest, extra: true })).toThrow();
    expect(() => validateCompatibilityManifest({ ...manifest, exceptions: Array(9).fill(manifest.exceptions[0]) })).toThrow();
    expect(() => validateCompatibilityManifest({ ...manifest, exceptions: [manifest.exceptions[0], manifest.exceptions[0]] })).toThrow();
    manifest.exceptions[0]!.preservedFiles.push(manifest.exceptions[0]!.preservedFiles[0]!);
    expect(() => validateCompatibilityManifest(manifest)).toThrow();
    expect(() => validateCompatibilityManifest({ version: 1, exceptions: [{ sourceSha: "unknown", imageDigest: digest, preservedFiles: [] }] })).toThrow();
  });

  it("requires production-role configuration equivalence before execution cutover", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); f.commit("preserve");
    const spec = { containerConcurrency: 500, timeoutSeconds: 3600, serviceAccountName: "platform@example.invalid",
      containers: [{ image: "old@" + digest, resources: { limits: { cpu: "2", memory: "2Gi" } }, ports: [{ containerPort: 8080 }],
        env: [{ name: "FIRST", value: "approved-private-value" }, { name: "SECRET", valueFrom: { secretKeyRef: { name: "key", key: "latest" } } }] }] };
    const revision = { ...f.revision, spec };
    const target = { metadata: { name: "production-candidate", labels: { "matrix-source-sha": f.git("rev-parse", "HEAD") } },
      status: { imageDigest: `sha256:${"b".repeat(64)}` }, spec: structuredClone(spec) };
    target.spec.containers[0]!.image = "new@" + target.status.imageDigest;
    target.spec.containers[0]!.env.reverse();
    const manifest = { ...manifestFor(f.live), exceptions: [{ ...manifestFor(f.live).exceptions[0], preserveRuntimeConfiguration: true }] };
    const verify = (productionRevision: unknown = target) => f.verify(manifest, { revision, productionRevision,
      productionRevisionName: "production-candidate", requireRuntimeConfiguration: true });
    expect(verify()).toMatchObject({ mode: "reviewed-content" });
    target.spec.containers[0]!.resources.limits.cpu = "1";
    expect(() => verify()).toThrow("Runtime configuration differs at spec.containers[0].resources.limits.cpu");
    expect(() => verify(null)).toThrow();
  });

  it("rejects every configuration drift without exposing environment or secret values", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); f.commit("preserve");
    const spec = { serviceAccountName: "approved@example.invalid", containers: [{ image: "old@" + digest,
      resources: { limits: { memory: "2Gi" } }, ports: [{ containerPort: 8080 }], env: [
        { name: "PLAIN", value: "approved-private-value" },
        { name: "SECRET", valueFrom: { secretKeyRef: { name: "approved-secret-name", key: "latest" } } },
      ] }] };
    const revision = { ...f.revision, spec };
    const target = { metadata: { name: "production-candidate", labels: { "matrix-source-sha": f.git("rev-parse", "HEAD") } }, status: { imageDigest: digest }, spec: structuredClone(spec) };
    const manifest = { ...manifestFor(f.live), exceptions: [{ ...manifestFor(f.live).exceptions[0], preserveRuntimeConfiguration: true }] };
    const mutations = [
      (value: typeof target) => { value.spec.serviceAccountName = "different@example.invalid"; },
      (value: typeof target) => { value.spec.containers[0]!.env[0]!.value = "unapproved-private-value"; },
      (value: typeof target) => { value.spec.containers[0]!.env[1]!.valueFrom!.secretKeyRef.key = "2"; },
      (value: typeof target) => { value.spec.containers[0]!.ports[0]!.containerPort = 9999; },
      (value: typeof target) => { value.metadata.labels["matrix-source-sha"] = f.base; },
      (value: typeof target) => { value.metadata.name = "ordinary-candidate"; },
      (value: typeof target) => { value.spec.containers[0]!.env.push(value.spec.containers[0]!.env[0]!); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(target); mutate(changed);
      let failure: unknown;
      try { f.verify(manifest, { revision, productionRevision: changed, productionRevisionName: "production-candidate", requireRuntimeConfiguration: true }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("private-value");
      expect(String(failure)).not.toContain("approved-secret-name");
    }
  });

  it("requires the named production-role target and never substitutes the ordinary candidate", () => {
    const f = fixture(); f.put(path, "reviewed live auth\n");
    f.put("specs/639-managed-model-selection/current-runtime-compatibility.json", JSON.stringify({ version: 1,
      exceptions: [{ ...manifestFor(f.live).exceptions[0], preserveRuntimeConfiguration: true }] }));
    const candidate = f.commit("preserve with runtime configuration record");
    const env = { CLOUD_RUN_SERVICE: "platform", GCP_PROJECT_ID: "test-project", GCP_REGION: "europe-west3", GITHUB_SHA: candidate,
      GITHUB_WORKSPACE: f.root, REQUIRE_RUNTIME_CONFIGURATION_PRESERVATION: "true", CANDIDATE_REVISION: "ordinary-candidate" };
    const calls: string[] = [];
    const spec = { containers: [{ image: `old@${digest}`, env: [{ name: "HOST_BUNDLE_PUBLISH_ENABLED", value: "true" }] }] };
    const execute = (_command: string, args: string[]) => {
      calls.push(args[3]!);
      if (args[1] === "services") return JSON.stringify(service);
      expect(args.at(-1)).toContain("metadata.annotations");
      if (args[3] === "live-r1") return JSON.stringify({ ...f.revision, spec });
      expect(args[3]).toBe("production-candidate");
      return JSON.stringify({ metadata: { name: "production-candidate", labels: { "matrix-source-sha": candidate } }, status: { imageDigest: digest }, spec });
    };
    expect(() => verifyServingPlatformSource(env, execute)).toThrow("Production-role target revision is required");
    calls.length = 0;
    expect(verifyServingPlatformSource({ ...env, PRODUCTION_REVISION: "production-candidate" }, execute)).toMatchObject({ mode: "reviewed-content" });
    expect(calls).toEqual(["platform", "live-r1", "production-candidate"]);
    expect(() => verifyServingPlatformSource(env, () => { throw new Error("private CLI stderr"); })).toThrow("Cloud Run services provenance describe failed");
  });

  it.each([
    ["autoscaling.knative.dev/minScale", "1", "2"],
    ["run.googleapis.com/cpu-throttling", "false", "true"],
  ])("rejects a changed %s annotation without exposing values", (key, before, after) => {
    const f = fixture(); f.put(path, "reviewed live auth\n"); f.commit("preserve");
    const spec = { containers: [{ image: `old@${digest}` }] };
    const revision = { ...f.revision, metadata: { ...f.revision.metadata, annotations: { [key]: before,
      "run.googleapis.com/client-name": "old-client" } }, spec };
    const target = { metadata: { name: "production-candidate", labels: { "matrix-source-sha": f.git("rev-parse", "HEAD") },
      annotations: { [key]: before, "run.googleapis.com/client-name": "new-client" } }, status: { imageDigest: digest }, spec };
    const manifest = { version: 1, exceptions: [{ ...manifestFor(f.live).exceptions[0], preserveRuntimeConfiguration: true }] };
    const verify = () => f.verify(manifest, { revision, productionRevision: target,
      productionRevisionName: "production-candidate", requireRuntimeConfiguration: true });
    expect(verify()).toMatchObject({ mode: "reviewed-content" });
    target.metadata.annotations[key] = after;
    expect(() => verify()).toThrow(`Runtime configuration differs at metadata.annotations[${key}]`);
  });

  it("keeps the reviewed production manifest bounded and source-only", () => {
    const manifest = validateCompatibilityManifest(readFileSync("specs/639-managed-model-selection/current-runtime-compatibility.json", "utf8"));
    expect(manifest.exceptions).toHaveLength(1);
    expect(manifest.exceptions[0].preservedFiles).toHaveLength(16);
    expect(manifest.exceptions[0].sourceSha).toBe("ccdac762ff830e547d6b26ea18a98ccec6d31b3c");
  });
});
