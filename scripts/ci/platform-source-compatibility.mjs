#!/usr/bin/env node

// A read-only provenance gate. This must run before any candidate can start migrations/workers.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MANIFEST = "specs/639-managed-model-selection/current-runtime-compatibility.json";
const gitOptions = { encoding: "utf8", timeout: 10_000, maxBuffer: MAX_FILE_BYTES, stdio: ["ignore", "pipe", "pipe"] };

class CompatibilityError extends Error {}
function fail(message) { throw new CompatibilityError(message); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function boundedJson(value) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); }
  catch { fail("Invalid compatibility JSON"); }
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_JSON_BYTES) fail("Compatibility JSON exceeds size limit");
  try { return JSON.parse(text); }
  catch { fail("Invalid compatibility JSON"); }
}
function keys(value, allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function sourcePath(path) {
  return typeof path === "string" && path.length <= 240 && /^packages\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?js|tsx?|json)$/.test(path)
    && !path.split("/").some((part) => part === "." || part === "..");
}
export function validateCompatibilityManifest(input) {
  const manifest = boundedJson(input);
  if (!keys(manifest, ["version", "exceptions"]) || manifest.version !== 1 || !Array.isArray(manifest.exceptions)
    || manifest.exceptions.length > 8) fail("Invalid compatibility manifest");
  const sources = new Set();
  for (const entry of manifest.exceptions) {
    if (!keys(entry, ["sourceSha", "imageDigest", "preservedFiles", "preserveRuntimeConfiguration"]) || !SHA.test(entry.sourceSha ?? "")
      || !DIGEST.test(entry.imageDigest ?? "") || !Array.isArray(entry.preservedFiles)
      || (entry.preserveRuntimeConfiguration !== undefined && typeof entry.preserveRuntimeConfiguration !== "boolean")
      || entry.preservedFiles.length < 1 || entry.preservedFiles.length > 64 || sources.has(entry.sourceSha)) {
      fail("Invalid compatibility exception");
    }
    sources.add(entry.sourceSha);
    const paths = new Set();
    for (const file of entry.preservedFiles) {
      if (!keys(file, ["path", "sha256"]) || !sourcePath(file.path) || !HASH.test(file.sha256 ?? "") || paths.has(file.path)) {
        fail("Invalid preserved source file");
      }
      paths.add(file.path);
    }
  }
  return manifest;
}
export function defaultServingRevision(input) {
  const service = boundedJson(input);
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic) || traffic.length < 1 || traffic.length > 256) fail("Invalid or oversized Cloud Run traffic");
  const serving = [];
  for (const target of traffic) {
    if (!record(target)) fail("Invalid Cloud Run traffic target");
    const percent = target.percent ?? 0;
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) fail("Invalid Cloud Run traffic percentage");
    if (!NAME.test(target.revisionName ?? "") || (target.tag !== undefined && !NAME.test(target.tag))) {
      fail("Cloud Run traffic must resolve to a named revision");
    }
    if (percent > 0) serving.push(target);
  }
  if (serving.length !== 1 || serving[0].percent !== 100) fail("Cloud Run default traffic is ambiguous or split");
  return serving[0].revisionName;
}
function git(root, args) {
  try { return execFileSync("git", ["-C", root, ...args], gitOptions).trim(); }
  catch { fail("Candidate Git source could not be verified"); }
}
function hash(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function preserveFile(root, candidateSha, file) {
  const path = resolve(root, file.path);
  // Reject symlinks anywhere in a path, including links resolving back inside the checkout.
  let current = root;
  for (const part of file.path.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) fail("Preserved source path must not contain symlinks");
  }
  if (!realpathSync(path).startsWith(`${root}${sep}`)) fail("Preserved source path escapes checkout");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail("Invalid or oversized preserved source file");
  const tree = git(root, ["ls-tree", candidateSha, "--", file.path]);
  if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(tree)) fail("Preserved source must be a tracked regular file");
  let blob;
  try { blob = execFileSync("git", ["-C", root, "show", `${candidateSha}:${file.path}`], { ...gitOptions, encoding: "buffer" }); }
  catch { fail("Preserved source blob could not be verified"); }
  if (hash(blob) !== file.sha256 || hash(readFileSync(path)) !== file.sha256) fail("Candidate does not preserve reviewed live source files");
}
function canonicalConfiguration(spec) {
  if (!record(spec) || !Array.isArray(spec.containers) || spec.containers.length !== 1) fail("Unverifiable runtime configuration");
  const copy = structuredClone(spec);
  for (const container of copy.containers) {
    if (!record(container) || typeof container.image !== "string") fail("Unverifiable runtime container configuration");
    delete container.image;
    if (container.env !== undefined) {
      if (!Array.isArray(container.env) || container.env.length > 256) fail("Invalid or oversized runtime environment");
      const names = new Set();
      for (const entry of container.env) {
        if (!record(entry) || typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.name) || names.has(entry.name)) {
          fail("Invalid or ambiguous runtime environment");
        }
        names.add(entry.name);
      }
      container.env.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  let nodes = 0;
  const canonical = (value, depth = 0) => {
    if (++nodes > 20_000 || depth > 32) fail("Runtime configuration exceeds structural limits");
    if (Array.isArray(value)) {
      if (value.length > 1024) fail("Runtime configuration exceeds structural limits");
      return value.map((item) => canonical(item, depth + 1));
    }
    if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
    return value;
  };
  return canonical(copy);
}
function firstDifference(left, right, path = "spec") {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index++) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (record(left) && record(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const safeKey = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(key) ? key : "[key]";
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return `${path}.${safeKey}`;
      const difference = firstDifference(left[key], right[key], `${path}.${safeKey}`);
      if (difference) return difference;
    }
    return null;
  }
  return path;
}
const runtimeAnnotationNames = [
  "autoscaling.knative.dev/minScale",
  "autoscaling.knative.dev/maxScale",
  "run.googleapis.com/cpu-throttling",
  "run.googleapis.com/startup-cpu-boost",
  "run.googleapis.com/execution-environment",
];
function verifyRuntimeAnnotations(live, target) {
  const before = live.metadata?.annotations ?? {};
  const after = target.metadata?.annotations ?? {};
  if (!record(before) || !record(after)) fail("Unverifiable runtime annotations");
  for (const key of runtimeAnnotationNames) {
    // Missing versus explicit defaults are intentionally not guessed equivalent.
    // Ignore Cloud Run's generated/client annotations, which change with each rollout.
    if ((before[key] !== undefined && typeof before[key] !== "string")
      || (after[key] !== undefined && typeof after[key] !== "string")) fail("Unverifiable runtime annotation value");
    if (before[key] !== after[key]) fail(`Runtime configuration differs at metadata.annotations[${key}]`);
  }
}
function verifyRuntimeConfiguration(live, targetInput, targetName, candidateSha) {
  const target = boundedJson(targetInput);
  const image = target?.status?.imageDigest;
  if (!NAME.test(targetName ?? "") || target?.metadata?.name !== targetName
    || target?.metadata?.labels?.["matrix-source-sha"] !== candidateSha
    || typeof image !== "string" || !DIGEST.test(image.slice(image.lastIndexOf("@") + 1))) {
    fail("Production-role target has unknown source or immutable image");
  }
  verifyRuntimeAnnotations(live, target);
  const difference = firstDifference(canonicalConfiguration(live.spec), canonicalConfiguration(target.spec));
  if (difference) fail(`Runtime configuration differs at ${difference}`);
}
export function verifyPlatformSourceCompatibility({ root, candidateSha, manifest, service, revision, productionRevision, productionRevisionName, requireRuntimeConfiguration = false }) {
  const reviewed = validateCompatibilityManifest(manifest);
  const revisionName = defaultServingRevision(service);
  const live = boundedJson(revision);
  const sourceSha = live?.metadata?.labels?.["matrix-source-sha"];
  const image = live?.status?.imageDigest;
  const imageDigest = typeof image === "string" ? image.slice(image.lastIndexOf("@") + 1) : "";
  if (live?.metadata?.name !== revisionName || !SHA.test(sourceSha ?? "") || !DIGEST.test(imageDigest)) {
    fail("Default-serving revision has unknown source or immutable image");
  }
  root = realpathSync(root);
  if (!SHA.test(candidateSha ?? "") || git(root, ["rev-parse", "HEAD"]) !== candidateSha) fail("Candidate checkout does not match deployment SHA");
  const clean = spawnSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--"], gitOptions);
  if (clean.status !== 0 || clean.error) fail("Candidate checkout has unverified tracked changes");
  const pinned = reviewed.exceptions.find((entry) => entry.sourceSha === sourceSha);
  if (pinned) {
    if (pinned.imageDigest !== imageDigest) fail("Default-serving image differs from reviewed compatibility exception");
    for (const file of pinned.preservedFiles) {
      try { preserveFile(root, candidateSha, file); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("Candidate does not preserve")) throw error;
        fail("Preserved source file verification failed");
      }
    }
    if (pinned.preserveRuntimeConfiguration && requireRuntimeConfiguration) {
      verifyRuntimeConfiguration(live, productionRevision, productionRevisionName, candidateSha);
    }
    return { mode: "reviewed-content", revisionName, sourceSha };
  }
  const ancestry = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", sourceSha, candidateSha], gitOptions);
  if (ancestry.status !== 0 || ancestry.error) fail("Default-serving source is not an ancestor or reviewed compatibility exception");
  return { mode: "ancestor", revisionName, sourceSha };
}
export function verifyServingPlatformSource(env = process.env, execute = execFileSync) {
  const values = [env.CLOUD_RUN_SERVICE, env.GCP_PROJECT_ID, env.GCP_REGION];
  if (values.some((value) => !NAME.test(value ?? ""))) fail("Invalid Cloud Run deployment identifiers");
  if (env.REQUIRE_RUNTIME_CONFIGURATION_PRESERVATION !== undefined && env.REQUIRE_RUNTIME_CONFIGURATION_PRESERVATION !== "true") {
    fail("Invalid runtime configuration preservation mode");
  }
  const requireRuntimeConfiguration = env.REQUIRE_RUNTIME_CONFIGURATION_PRESERVATION === "true";
  const root = realpathSync(resolve(env.GITHUB_WORKSPACE || process.cwd()));
  let manifestPath = root;
  for (const part of MANIFEST.split("/")) {
    manifestPath = resolve(manifestPath, part);
    if (lstatSync(manifestPath).isSymbolicLink()) fail("Compatibility manifest path must not contain symlinks");
  }
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) fail("Invalid compatibility manifest file");
  const manifest = validateCompatibilityManifest(readFileSync(manifestPath, "utf8"));
  const describe = (kind, name, projection) => {
    try {
      return boundedJson(execute("gcloud", ["run", kind, "describe", name, "--project", env.GCP_PROJECT_ID,
        "--region", env.GCP_REGION, "--quiet", `--format=${projection}`], {
        encoding: "utf8", timeout: 60_000, maxBuffer: MAX_JSON_BYTES, stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch { fail(`Cloud Run ${kind} provenance describe failed`); }
  };
  const service = describe("services", env.CLOUD_RUN_SERVICE, "json(status.traffic)");
  const revisionName = defaultServingRevision(service);
  const projection = `json(metadata.name,metadata.labels,status.imageDigest${requireRuntimeConfiguration ? ",metadata.annotations,spec" : ""})`;
  const revision = describe("revisions", revisionName, projection);
  const pinned = manifest.exceptions.find((entry) => entry.sourceSha === revision?.metadata?.labels?.["matrix-source-sha"]);
  let productionRevision;
  if (requireRuntimeConfiguration && pinned?.preserveRuntimeConfiguration) {
    if (!NAME.test(env.PRODUCTION_REVISION ?? "")) fail("Production-role target revision is required for configuration preservation");
    productionRevision = describe("revisions", env.PRODUCTION_REVISION, projection);
  }
  return verifyPlatformSourceCompatibility({ root, candidateSha: env.GITHUB_SHA, manifest, service, revision,
    requireRuntimeConfiguration, productionRevision, productionRevisionName: env.PRODUCTION_REVISION });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(verifyServingPlatformSource())}\n`); }
  catch (error) {
    // Never dump Cloud Run documents, CLI stderr, or local paths into workflow output.
    process.stderr.write(`Platform source compatibility gate failed: ${error instanceof CompatibilityError ? error.message : "verification failed"}\n`);
    process.exitCode = 1;
  }
}
