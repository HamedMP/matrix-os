import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const day = 86_400_000;
const checks = ["metering", "canary_metrics", "policy_health", "spend_fuse", "kill_switch",
  "auth_leakage", "surface_parity", "rollback", "review_gates", "public_docs"];

function fixture() {
  return {
    schemaVersion: 1, sourceSha: sha, stage: "preview",
    reviewedAt: new Date(Date.now() - day).toISOString(),
    validThrough: new Date(Date.now() + day).toISOString(),
    configuration: {
      projectId: "matrix-project", region: "europe-west3", relayService: "matrix-ai-relay",
      relayServiceAccount: "relay@matrix-project.iam.gserviceaccount.com",
      platformOrigin: "https://app.matrix-os.com",
      cloudflareGatewayUrl: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix-funded-production/anthropic",
      secretVersions: { gatewayToken: "1", workersToken: "2", controlToken: "3", metadataSecret: "4" },
      pricing: Object.fromEntries((["SONNET", "GLM", "JEV"] as const).flatMap(model =>
        ["REVIEW_VERSION", "REVIEWED_AT", "VALID_THROUGH"].map(field =>
          [`MATRIX_${model === "JEV" ? "" : "FUNDED_"}${model}_PRICING_${field}`,
            field === "REVIEW_VERSION" ? { SONNET: "anthropic-2026-08-31-standard", GLM: "cloudflare-2026-09-10-glm-flash", JEV: "typesafe-jev-input-2026-09" }[model]
              : new Date(Date.now() + (field === "REVIEWED_AT" ? -day : day)).toISOString()]))),
    },
    checks: Object.fromEntries(checks.map(name => [name, { status: "passed", path: `${name}.json` }])),
  };
}

function verify(receipt = fixture(), options: Record<string, unknown> = {}) {
  // Build real ZIP bytes, then exercise the same Python verifier used before cloud authentication.
  const result = spawnSync("python3", ["-c", `
import hashlib, importlib.util, io, json, os, sys, zipfile
spec = importlib.util.spec_from_file_location("gate", "scripts/verify-funded-relay-evidence.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
data = json.load(sys.stdin)
receipt = data["receipt"]
files = {check["path"]: b'{"evidence":"recorded elsewhere; fixture only"}' for check in receipt["checks"].values()}
for check in receipt["checks"].values():
    check["sha256"] = hashlib.sha256(files[check["path"]]).hexdigest()
raw = json.dumps(receipt).encode()
if data.get("duplicateJson"): raw = raw.replace(b'{', b'{"schemaVersion":1,', 1)
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    archive.writestr("receipt.json", raw)
    for path, body in files.items(): archive.writestr(path, b'x' * 131073 if data.get("oversized") else body)
    if data.get("duplicate"): archive.writestr("receipt.json", raw)
    if data.get("traversal"): archive.writestr("../outside.json", b'{}')
    if data.get("tamper"): archive.writestr("extra.json", b'{}')
run = {"head_sha": "${sha}", "head_branch": "main", "event": "workflow_dispatch", "conclusion": "success",
 "path": ".github/workflows/funded-ai-acceptance-evidence.yml", "repository": {"full_name": "HamedMP/matrix-os"},
 "head_repository": {"full_name": "HamedMP/matrix-os"}}
run.update(data.get("run", {}))
try:
    result = gate.verify_evidence(buffer.getvalue(), hashlib.sha256(raw).hexdigest(), "${sha}", run,
        "HamedMP/matrix-os", "production" if data.get("promotion") else "preview")
    if data.get("candidate"):
        gate.verify_candidate(result, data["candidate"])
    if data.get("exercisePromotion"):
        config = result["configuration"]
        os.environ.update({"DEPLOY_ENVIRONMENT": "production", "GITHUB_REF": "refs/heads/main", "GITHUB_ENV": "/dev/null"})
        os.environ.update({key: config[field] for field, key in gate.CONFIG_ENV.items()})
        os.environ.update(config["pricing"])
        entries = [{"name": key, "value": value} for key, value in {
          **gate.FIXED_ENV,
          "PLATFORM_INTERNAL_URL": config["platformOrigin"], "CLOUDFLARE_AI_GATEWAY_URL": config["cloudflareGatewayUrl"],
          **config["pricing"]}.items()]
        names = {"gatewayToken":"CLOUDFLARE_AI_GATEWAY_TOKEN", "workersToken":"CLOUDFLARE_WORKERS_AI_TOKEN",
          "controlToken":"AI_RELAY_CONTROL_TOKEN", "metadataSecret":"AI_RELAY_METADATA_SECRET"}
        entries += [{"name": names[key], "valueFrom": {"secretKeyRef": {"name": secret, "key": config["secretVersions"][key]}}}
          for key, (_, secret) in gate.SECRETS.items()]
        revision = {"metadata": {"labels": {"matrix-source-sha": "${sha}"}, "annotations": {"autoscaling.knative.dev/maxScale": "3"}},
          "spec": {"serviceAccountName": config["relayServiceAccount"], "containerConcurrency": 32, "timeoutSeconds": 900,
            "containers": [{"image": result["candidate"]["image"], "env": entries, "resources": {"limits": {"cpu":"1000m", "memory":"512Mi"}}}]},
          "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        change = data.get("candidateChange")
        if change == "secret": entries[-1]["valueFrom"]["secretKeyRef"]["key"] = "999"
        if change == "source": revision["metadata"]["labels"]["matrix-source-sha"] = "c" * 40
        if change == "account": revision["spec"]["serviceAccountName"] = "other@matrix-project.iam.gserviceaccount.com"
        if change == "pricing": entries[-5]["value"] = "different"
        if change == "duplicate": entries.append(entries[0])
        if change == "notReady": revision["status"]["conditions"][0]["status"] = "False"
        if change == "environment": os.environ["PLATFORM_INTERNAL_URL"] = "https://preview.example.test"
        if change == "unboundedRate": entries[2]["value"] = "99999"
        if change == "unreviewedEnv": entries.append({"name":"UNREVIEWED_SETTING", "value":"true"})
        if change == "maxInstances": revision["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "999"
        if change == "cloudConcurrency": revision["spec"]["containerConcurrency"] = 1000
        if change == "memory": revision["spec"]["containers"][0]["resources"]["limits"]["memory"] = "8Gi"
        if change == "entrypoint": container = revision["spec"]["containers"][0]; container["command"] = ["node"]; container["args"] = ["-e", "process.exit(0)"]
        if change == "mount": revision["spec"]["containers"][0]["volumeMounts"] = [{"name":"override", "mountPath":"/app"}]
        service = {"status": {"traffic": [{"tag":"candidate", "revisionName":result["candidate"]["revision"],
          "url":"https://candidate---matrix-ai-relay-abcdef-ey.a.run.app"}]}}
        gate.load_evidence = lambda stage: result
        gate.cloud_json = lambda kind, name: service if kind == "services" else revision
        gate.promotion()
    if data.get("redirect"):
        from urllib.error import HTTPError
        os.environ.update({"GITHUB_REPOSITORY": "HamedMP/matrix-os", "GH_TOKEN": "fixture-token"})
        def fake_fetch(url, limit, token=None, accept=None):
            if url.startswith("https://api.github.com/"):
                raise HTTPError(url, 302, "Redirect", {"Location": data["redirect"]}, None)
            assert token is None
            return b"archive"
        gate.fetch_bytes = fake_fetch
        assert gate.download_archive("/actions/artifacts/1/zip") == b"archive"
    print("accepted")
except (ValueError, KeyError, TypeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`], { cwd: root, input: JSON.stringify({ receipt, ...options }), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toMatch(/Traceback|ModuleNotFoundError|AssertionError/);
  return result;
}

describe("reviewed funded Relay release evidence", () => {
  it("accepts only a hash-pinned exact-source reviewed metadata package", () => {
    expect(verify().status).toBe(0);
  });
  it.each([
    ["different source", (r: ReturnType<typeof fixture>) => { r.sourceSha = "c".repeat(40); }],
    ["missing GA gate", (r: ReturnType<typeof fixture>) => { delete r.checks.metering; }],
    ["failed gate", (r: ReturnType<typeof fixture>) => { r.checks.kill_switch!.status = "failed"; }],
    ["expired review", (r: ReturnType<typeof fixture>) => { r.validThrough = new Date(Date.now() - 1).toISOString(); }],
    ["overlong review", (r: ReturnType<typeof fixture>) => { r.validThrough = new Date(Date.now() + 8 * day).toISOString(); }],
    ["Preview Platform", (r: ReturnType<typeof fixture>) => { r.configuration.platformOrigin = "https://pr---matrix-platform-preview.run.app"; }],
    ["Preview upstream", (r: ReturnType<typeof fixture>) => { r.configuration.cloudflareGatewayUrl = r.configuration.cloudflareGatewayUrl.replace("production", "preview"); }],
    ["unpinned secret", (r: ReturnType<typeof fixture>) => { r.configuration.secretVersions.workersToken = "latest"; }],
  ])("rejects %s", (_name, mutate) => {
    const receipt = fixture(); mutate(receipt);
    expect(verify(receipt).status).toBe(1);
  });
  it.each([
    { duplicate: true }, { duplicateJson: true }, { traversal: true }, { tamper: true }, { oversized: true },
    { run: { conclusion: "failure" } }, { run: { head_branch: "feature" } },
    { run: { event: "pull_request" } }, { run: { head_sha: "c".repeat(40) } },
    { run: { head_repository: { full_name: "other/repo" } } },
    { run: { path: ".github/workflows/unreviewed.yml" } },
  ])("rejects untrusted artifact or run metadata: %j", options => {
    expect(verify(fixture(), options).status).toBe(1);
  });
  it("cannot promote Preview evidence or a changed candidate", () => {
    expect(verify(fixture(), { promotion: true }).status).toBe(1);
    const receipt = productionFixture();
    expect(verify(receipt, { promotion: true, candidate: { revision: "other", image: receipt.candidate.image } }).status).toBe(1);
  });
  it("accepts production evidence for the exact candidate and rejects an altered image", () => {
    const receipt = productionFixture();
    expect(verify(receipt, { promotion: true, candidate: receipt.candidate }).status).toBe(0);
    expect(verify(receipt, { promotion: true, candidate: { ...receipt.candidate, image: receipt.candidate.image.replace(digest, `sha256:${"c".repeat(64)}`) } }).status).toBe(1);
  });
  it("verifies actual candidate configuration before promotion", () => {
    expect(verify(productionFixture(), { promotion: true, exercisePromotion: true }).status).toBe(0);
  });
  it.each(["secret", "source", "account", "pricing", "duplicate", "notReady", "environment",
    "unboundedRate", "unreviewedEnv", "maxInstances", "cloudConcurrency", "memory", "entrypoint", "mount"])(
    "rejects drift in actual candidate %s", candidateChange => {
      expect(verify(productionFixture(), { promotion: true, exercisePromotion: true, candidateChange }).status).toBe(1);
    });
  it("keeps production promotion separate from candidate rebuild and binds distinct upstream secrets", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ai-relay-cloud-run.yml"), "utf8");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("MATRIX_FUNDED_AI_ACCEPTANCE_RUN_ID");
    expect(workflow).toContain("scripts/verify-funded-relay-evidence.py configuration");
    expect(workflow).toContain("scripts/verify-funded-relay-evidence.py promotion");
    expect(workflow).toContain("scripts/verify-funded-relay-evidence.py deployment-preflight");
    expect(workflow).toContain("scripts/verify-funded-relay-evidence.py candidate-isolation");
    expect(workflow).toContain("inputs.environment != 'production' || !inputs.promote");
    expect(workflow).toContain("CLOUDFLARE_WORKERS_AI_TOKEN=${WORKERS_TOKEN_SECRET}:${WORKERS_TOKEN_VERSION}");
    expect(workflow).not.toContain("Production funded AI deployment remains blocked until preview metering is verified.");
  });
  it("requires an existing production baseline and verifies actual candidate isolation", () => {
    const result = spawnSync("python3", ["-c", `
import importlib.util, os
spec=importlib.util.spec_from_file_location('gate','scripts/verify-funded-relay-evidence.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
os.environ.update({'DEPLOY_ENVIRONMENT':'production','GITHUB_REF':'refs/heads/main',
 'AI_RELAY_CLOUD_RUN_SERVICE':'matrix-ai-relay','CANDIDATE_REVISION':'matrix-ai-relay-00002-abc',
 'IMAGE_DIGEST':'fixture@sha256:abc','GITHUB_SHA':'${sha}'})
gate.cloud_json=lambda kind,name: {'status':{}}
try: gate.deployment_preflight(); raise AssertionError('missing baseline accepted')
except ValueError: pass
gate.cloud_json=lambda kind,name: {'status':{'latestReadyRevisionName':'matrix-ai-relay-00001-abc'}}
gate.deployment_preflight()
service={'status':{'latestReadyRevisionName':'matrix-ai-relay-00002-abc','traffic':[
 {'tag':'candidate','revisionName':'matrix-ai-relay-00002-abc','percent':0},
 {'revisionName':'matrix-ai-relay-00001-abc','percent':100}]}}
revision={'metadata':{'labels':{'matrix-source-sha':'${sha}'}},'spec':{'containers':[{'image':'fixture@sha256:abc'}]}}
gate.cloud_json=lambda kind,name: service if kind=='services' else revision
gate.candidate_isolation()
for target in ({'revisionName':'matrix-ai-relay-00002-abc','percent':100}, {'latestRevision':True,'percent':100}):
 service['status']['traffic'][1]=target
 try: gate.candidate_isolation(); raise AssertionError('default candidate traffic accepted')
 except ValueError: pass
print('passed')
`], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(result.status, result.stderr).toBe(0);
  });
  it("downloads a signed GitHub blob without forwarding the API credential", () => {
    expect(verify(fixture(), { redirect: "https://results.blob.core.windows.net/archive" }).status).toBe(0);
  });
  it.each(["https://evil.example/archive", "http://results.blob.core.windows.net/archive",
    "https://results.blob.core.windows.net:444/archive", "https://user:password@results.blob.core.windows.net/archive"])(
    "rejects untrusted artifact redirect %s", redirect => {
      expect(verify(fixture(), { redirect }).status).toBe(1);
    });
  it("rejects absent production evidence and production dispatch from an unreviewed branch", () => {
    for (const ref of ["refs/heads/feature", "refs/heads/main"]) {
      const result = spawnSync("python3", ["scripts/verify-funded-relay-evidence.py", "configuration"], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { PATH: process.env.PATH, DEPLOY_ENVIRONMENT: "production", GITHUB_REF: ref },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("production remains blocked");
    }
  });
  it("preserves staging bindings without any production acceptance request", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-relay-env-"));
    try {
      const output = join(directory, "github-env");
      const result = spawnSync("python3", ["scripts/verify-funded-relay-evidence.py", "configuration"], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { PATH: process.env.PATH, DEPLOY_ENVIRONMENT: "staging", GITHUB_ENV: output },
      });
      expect(result.status).toBe(0);
      const values = readFileSync(output, "utf8");
      expect(values).toContain("GATEWAY_TOKEN_SECRET=cloudflare-ai-gateway-token\n");
      expect(values).toContain("WORKERS_TOKEN_SECRET=cloudflare-workers-ai-token-preview\n");
      expect(values).toContain("WORKERS_TOKEN_VERSION=latest\n");
      expect(values).not.toContain("-production");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function productionFixture() {
  return { ...fixture(), stage: "production", candidate: {
    revision: "matrix-ai-relay-00001-abc",
    image: `europe-west3-docker.pkg.dev/matrix-project/registry/matrix-ai-relay@${digest}`,
  } };
}
