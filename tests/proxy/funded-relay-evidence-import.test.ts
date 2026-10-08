import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Mock only urllib's HTTP boundary: importer, loader, ZIP/hash checks and
// GitHub API/download routing all execute their production implementations.
const program = String.raw`
import hashlib, importlib.util, io, json, os, pathlib, sys, tempfile, urllib.error, zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gate", pathlib.Path("scripts/verify-funded-relay-evidence.py").resolve())
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
case = json.load(sys.stdin)
scenario, operation = case["scenario"], case["operation"]
source, repository, token = "a" * 40, "HamedMP/matrix-os", "synthetic-http-boundary-token"
now = datetime.now(timezone.utc)
date = lambda offset: (now + timedelta(days=offset)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
models = (("SONNET", "anthropic-2026-08-31-standard"), ("GLM", "cloudflare-2026-09-10-glm-flash"), ("JEV", "typesafe-jev-input-2026-09"))
pricing = {}
for model, version in models:
    prefix = "MATRIX_" + ("" if model == "JEV" else "FUNDED_") + model + "_PRICING_"
    pricing.update({prefix + "REVIEW_VERSION": version, prefix + "REVIEWED_AT": date(-1), prefix + "VALID_THROUGH": date(1)})
config = {"projectId": "matrix-project", "region": "europe-west3", "relayService": "matrix-ai-relay",
    "relayServiceAccount": "relay@matrix-project.iam.gserviceaccount.com", "platformOrigin": "https://app.matrix-os.com",
    "cloudflareGatewayUrl": "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix-funded-production/anthropic",
    "secretVersions": {"gatewayToken":"1", "workersToken":"2", "controlToken":"3", "metadataSecret":"4"}, "pricing": pricing}
names = ("metering", "canary_metrics", "policy_health", "spend_fuse", "kill_switch", "auth_leakage", "surface_parity", "rollback", "review_gates", "public_docs")
files = {name + ".json": json.dumps({"fixture": True, "check": name}).encode() for name in names}
checks = {name: {"status":"passed", "path":name + ".json", "sha256":hashlib.sha256(files[name + ".json"]).hexdigest()} for name in names}
stage = "production" if scenario == "production" else "preview"
receipt = {"schemaVersion":1, "sourceSha":source, "stage":stage, "reviewedAt":date(-1), "validThrough":date(1), "configuration":config, "checks":checks}
if stage == "production":
    receipt["candidate"] = {"revision":"matrix-ai-relay-00001-abc", "image":"europe-west3-docker.pkg.dev/matrix-project/registry/matrix-ai-relay@sha256:" + "b" * 64}
if scenario == "wrong-source": receipt["sourceSha"] = "c" * 40
if scenario == "expired-review": receipt["validThrough"] = date(-0.5)
files["receipt.json"] = json.dumps(receipt).encode()
stream = io.BytesIO()
with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, body in files.items():
        archive.writestr(name, b"x" * 131073 if scenario == "large-entry" and name == "metering.json" else body)
    if scenario == "duplicate-path": archive.writestr("receipt.json", files["receipt.json"])
    if scenario == "traversal": archive.writestr("../outside.json", b"{}")
archive_bytes = stream.getvalue()
if scenario == "invalid-zip": archive_bytes = b"not a ZIP"
if scenario == "large-download": archive_bytes = b"x" * (2 * 1024 * 1024 + 1)

run = {"head_sha":source, "head_branch":"main", "event":"workflow_dispatch", "status":"completed", "conclusion":"success",
    "path":".github/workflows/funded-ai-acceptance-evidence.yml", "repository":{"full_name":repository}, "head_repository":{"full_name":repository}}
run_changes = {"run-failed": {"conclusion":"failure"}, "run-push": {"event":"push"},
    "run-branch": {"head_branch":"feature"}, "run-source": {"head_sha":"c" * 40},
    "run-repository": {"repository":{"full_name":"another/repo"}},
    "run-fork": {"head_repository":{"full_name":"another/repo"}},
    "run-workflow": {"path":".github/workflows/unreviewed.yml"},
    "run-in-progress": {"status":"in_progress"}, "run-queued": {"status":"queued"}}
run.update(run_changes.get(scenario, {}))
if scenario == "run-status-missing": run.pop("status")
selected = {"id":55, "name":"funded-ai-production-acceptance", "expired":False, "size_in_bytes":len(archive_bytes)}
# Underreported metadata must not defeat the actual streamed-byte cap.
if scenario == "large-download": selected["size_in_bytes"] = 128
artifacts = {"total_count":1, "artifacts":[selected]}
if scenario == "missing-artifact": artifacts = {"total_count":0, "artifacts":[]}
if scenario == "wrong-artifact-name": selected["name"] = "unrelated"
if scenario == "duplicate-artifact": artifacts = {"total_count":2, "artifacts":[selected, dict(selected, id=56)]}
if scenario == "expired-artifact": selected["expired"] = True
if scenario == "large-artifact-metadata": selected["size_in_bytes"] = 2 * 1024 * 1024 + 1
if scenario == "artifact-count-cap": artifacts["total_count"] = 101
if scenario == "invalid-artifact-id": selected["id"] = True
if scenario == "unrelated-artifact": artifacts = {"total_count":2, "artifacts":[dict(selected, id=66, name="unrelated"), selected]}
api_root = "https://api.github.com/repos/" + repository
blob_url = "https://results.blob.core.windows.net/evidence.zip?signature=fixture"
download_path = "/releases/assets/44" if operation == "import" else "/actions/artifacts/55/zip"
requests = []

class Response:
    def __init__(self, body): self.body = io.BytesIO(body)
    def __enter__(self): return self
    def __exit__(self, *args): self.body.close()
    def read(self, limit): return self.body.read(limit)

class Opener:
    def open(self, request, timeout):
        url = request.full_url
        headers = dict((key.lower(), value) for key, value in request.header_items())
        assert timeout == 10
        assert request.get_method() == "GET"
        if url.startswith(api_root):
            assert headers.get("authorization") == "Bearer " + token
        else:
            assert headers.get("authorization") is None
        requests.append(url)
        if url == api_root + "/actions/runs/77":
            return Response(b"x" * 131073 if scenario == "large-api-response" else json.dumps(run).encode())
        if url == api_root + "/actions/runs/77/artifacts?per_page=100": return Response(json.dumps(artifacts).encode())
        if url == api_root + download_path:
            if scenario == "download-unavailable": raise urllib.error.HTTPError(url, 404, "Not found", {}, None)
            if scenario == "http-timeout": raise TimeoutError("fixture timeout")
            location = "https://untrusted.example/evidence.zip" if scenario == "untrusted-redirect" else blob_url
            raise urllib.error.HTTPError(url, 302, "Redirect", {"Location": location}, None)
        if url == blob_url:
            if scenario == "second-redirect": raise urllib.error.HTTPError(url, 302, "Redirect", {"Location":"https://untrusted.example/next"}, None)
            return Response(archive_bytes)
        raise AssertionError("Unexpected HTTP destination")

def opener(*handlers):
    assert len(handlers) == 1 and handlers[0] is gate.NoRedirect
    return Opener()

result = {}
with tempfile.TemporaryDirectory(prefix="matrix-evidence-boundary-") as temporary:
    os.chdir(temporary)
    os.environ.update({"GITHUB_REF":"refs/heads/main", "GITHUB_SHA":source, "GITHUB_REPOSITORY":repository, "GH_TOKEN":token,
        "EVIDENCE_ASSET_ID":"44", "EVIDENCE_ARCHIVE_SHA256":hashlib.sha256(archive_bytes).hexdigest(),
        "MATRIX_FUNDED_AI_ACCEPTANCE_RUN_ID":"77", "MATRIX_FUNDED_AI_ACCEPTANCE_RECEIPT_SHA256":hashlib.sha256(files["receipt.json"]).hexdigest(),
        "GITHUB_ENV":str(pathlib.Path(temporary, "github-env")), "DEPLOY_ENVIRONMENT":"production", "PROMOTE":"true" if stage == "production" else "false"})
    os.environ.update({"GCP_PROJECT_ID":config["projectId"], "GCP_REGION":config["region"],
        "AI_RELAY_CLOUD_RUN_SERVICE":config["relayService"], "AI_RELAY_CLOUD_RUN_SERVICE_ACCOUNT":config["relayServiceAccount"],
        "PLATFORM_INTERNAL_URL":config["platformOrigin"], "CLOUDFLARE_AI_GATEWAY_URL":config["cloudflareGatewayUrl"], **pricing})
    if scenario == "wrong-zip-hash": os.environ["EVIDENCE_ARCHIVE_SHA256"] = "f" * 64
    if scenario == "wrong-receipt-pin": os.environ["MATRIX_FUNDED_AI_ACCEPTANCE_RECEIPT_SHA256"] = "f" * 64
    if scenario == "invalid-run-id": os.environ["MATRIX_FUNDED_AI_ACCEPTANCE_RUN_ID"] = "77/path"
    if scenario == "invalid-asset-id": os.environ["EVIDENCE_ASSET_ID"] = "44/path"
    if scenario == "wrong-ref": os.environ["GITHUB_REF"] = "refs/heads/feature"
    if scenario == "missing-receipt-pin": os.environ.pop("MATRIX_FUNDED_AI_ACCEPTANCE_RECEIPT_SHA256")
    with patch("urllib.request.build_opener", opener):
        try:
            if operation == "import":
                gate.import_evidence()
                imported = pathlib.Path("funded-ai-evidence")
                assert {path.name:path.read_bytes() for path in imported.iterdir()} == files
                assert imported.stat().st_mode & 0o777 == 0o700
                result["imported"] = len(files)
            elif operation == "configuration":
                gate.configuration()
                output = pathlib.Path(os.environ["GITHUB_ENV"]).read_text()
                assert "WORKERS_TOKEN_SECRET=cloudflare-workers-ai-token-production\n" in output
                assert "WORKERS_TOKEN_VERSION=2\n" in output
                assert "latest" not in output and token not in output
                result["configured"] = True
            else:
                loaded = gate.load_evidence(stage)
                assert loaded == receipt
                result["loaded"] = True
            result["accepted"] = True
        except (KeyError, ValueError, TypeError, OSError, zipfile.BadZipFile) as error:
            result.update({"accepted":False, "error":type(error).__name__, "message":str(error)})
            if operation == "import": assert not pathlib.Path("funded-ai-evidence").exists()
    result["downloaded"] = blob_url in requests
    result["requestedPaths"] = [url.removeprefix(api_root) for url in requests if url.startswith(api_root)]
    result["requestCount"] = len(requests)
print(json.dumps(result))
`;

function execute(operation: "import" | "load" | "configuration", scenario = "valid") {
  const result = spawnSync("python3", ["-c", program], {
    input: JSON.stringify({ operation, scenario }), cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("synthetic-http-boundary-token");
  return JSON.parse(result.stdout) as { accepted: boolean; downloaded: boolean; requestCount: number;
    requestedPaths: string[]; imported?: number; loaded?: boolean; configured?: boolean; error?: string; message?: string };
}

describe("actual funded evidence importer at the GitHub HTTP boundary", () => {
  it.each(["valid", "production"])("imports exact hash-pinned %s evidence bytes into a private directory", scenario => {
    const result = execute("import", scenario);
    expect(result.accepted).toBe(true);
    expect(result.imported).toBe(11);
    expect(result.requestedPaths).toEqual(["/releases/assets/44"]);
    expect(result.downloaded).toBe(true);
  });
  it.each(["wrong-zip-hash", "invalid-zip", "wrong-source", "expired-review", "duplicate-path", "traversal", "large-entry"])(
    "rejects %s before writing any imported files", scenario => {
      const result = execute("import", scenario);
      expect(result.accepted).toBe(false);
      if (scenario === "wrong-zip-hash") expect(result.message).toBe("Evidence asset hash mismatch");
      if (scenario === "large-entry") expect(result.message).toBe("Invalid evidence entry");
    });
  it.each(["wrong-ref", "invalid-asset-id"])("rejects %s without HTTP", scenario => {
    const result = execute("import", scenario);
    expect(result.accepted).toBe(false);
    expect(result.requestCount).toBe(0);
  });
});

describe("actual funded evidence loader at the GitHub HTTP boundary", () => {
  it.each(["valid", "production", "unrelated-artifact"])("loads the selected exact-run, exact-receipt %s evidence", scenario => {
    const result = execute("load", scenario);
    expect(result.loaded).toBe(true);
    expect(result.requestedPaths).toEqual(["/actions/runs/77", "/actions/runs/77/artifacts?per_page=100", "/actions/artifacts/55/zip"]);
  });
  it.each(["missing-artifact", "wrong-artifact-name", "duplicate-artifact", "expired-artifact", "large-artifact-metadata",
    "artifact-count-cap", "invalid-artifact-id"])("rejects %s before downloading", scenario => {
      const result = execute("load", scenario);
      expect(result.accepted).toBe(false);
      expect(result.downloaded).toBe(false);
      expect(result.requestedPaths).not.toContain("/actions/artifacts/55/zip");
    });
  it.each(["run-failed", "run-push", "run-branch", "run-source", "run-repository", "run-fork", "run-workflow",
    "run-in-progress", "run-queued", "run-status-missing", "wrong-receipt-pin", "missing-receipt-pin", "wrong-source"])(
    "rejects untrusted run/receipt binding %s", scenario => {
      const result = execute("load", scenario);
      expect(result.accepted).toBe(false);
      if (scenario === "wrong-receipt-pin") expect(result.message).toBe("Receipt hash mismatch");
      if (["run-failed", "run-in-progress", "run-queued", "run-status-missing"].includes(scenario)) {
        expect(result.requestedPaths).toEqual(["/actions/runs/77"]);
        expect(result.downloaded).toBe(false);
      }
    });
  it("rejects an invalid run ID before HTTP", () => {
    const result = execute("load", "invalid-run-id");
    expect(result.accepted).toBe(false);
    expect(result.requestCount).toBe(0);
  });
  it.each(["valid", "production"])("wires reviewed %s evidence through actual production configuration", scenario => {
    expect(execute("configuration", scenario).configured).toBe(true);
  });
});

describe("bounded evidence HTTP downloads", () => {
  it.each(["import", "load"] as const)("bounds %s bytes, redirects and timeouts without credential leakage", operation => {
    for (const scenario of ["large-download", "download-unavailable", "untrusted-redirect", "second-redirect", "http-timeout"]) {
      const result = execute(operation, scenario);
      expect(result.accepted).toBe(false);
      if (scenario === "large-download") expect(result.message).toBe("Response exceeds evidence limit");
      if (scenario === "untrusted-redirect") expect(result.message).toBe("Untrusted artifact redirect");
      if (scenario === "http-timeout") expect(result.error).toBe("TimeoutError");
    }
  });
  it("bounds GitHub metadata response bytes", () => {
    const result = execute("load", "large-api-response");
    expect(result.accepted).toBe(false);
    expect(result.message).toBe("Response exceeds evidence limit");
  });
});
