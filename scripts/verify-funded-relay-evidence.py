#!/usr/bin/env python3
"""Verify reviewed metadata, not live acceptance; never execute archive content."""
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

MAX_ARCHIVE = 2 * 1024 * 1024
MAX_FILE = 128 * 1024
CHECKS = {"metering", "canary_metrics", "policy_health", "spend_fuse", "kill_switch",
          "auth_leakage", "surface_parity", "rollback", "review_gates", "public_docs"}
WORKFLOW = ".github/workflows/funded-ai-acceptance-evidence.yml"
ARTIFACT = "funded-ai-production-acceptance"
SECRETS = {"gatewayToken": ("GATEWAY_TOKEN", "cloudflare-ai-gateway-token-production"),
           "workersToken": ("WORKERS_TOKEN", "cloudflare-workers-ai-token-production"),
           "controlToken": ("CONTROL_TOKEN", "ai-relay-control-token"),
           "metadataSecret": ("METADATA_SECRET", "ai-relay-metadata-secret")}
CONFIG_ENV = {"projectId": "GCP_PROJECT_ID", "region": "GCP_REGION",
              "relayService": "AI_RELAY_CLOUD_RUN_SERVICE",
              "relayServiceAccount": "AI_RELAY_CLOUD_RUN_SERVICE_ACCOUNT",
              "platformOrigin": "PLATFORM_INTERNAL_URL",
              "cloudflareGatewayUrl": "CLOUDFLARE_AI_GATEWAY_URL"}
FIXED_ENV = {
    "MATRIX_FUNDED_AI_ENABLED": "true", "MATRIX_FUNDED_AI_RESERVATION_MODE": "usage",
    "MATRIX_FUNDED_AI_GLOBAL_CONCURRENCY": "16", "MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY": "2",
    "MATRIX_FUNDED_AI_GLOBAL_RATE_LIMIT": "60", "MATRIX_FUNDED_AI_RATE_LIMIT": "20",
    "MATRIX_FUNDED_AI_BETAS": ",".join(("claude-code-20250219", "structured-outputs-2025-11-13",
        "interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14",
        "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05",
        "mid-conversation-system-2026-04-07", "advisor-tool-2026-03-01", "effort-2025-11-24")),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field")
        result[key] = value
    return result


def read_json(body):
    return json.loads(body, object_pairs_hook=unique_object)


def timestamp(value):
    require(matches(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value), "Noncanonical review date")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def review_window(start, end, days):
    start, end = timestamp(start), timestamp(end)
    require(timedelta(0) < end - start <= timedelta(days=days), "Invalid review interval")
    require(start <= datetime.now(timezone.utc) < end, "Review is not current")


def archive_files(body):
    require(len(body) <= MAX_ARCHIVE, "Evidence archive too large")
    result = {}
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        require(1 <= len(archive.infolist()) <= 32, "Invalid evidence file count")
        total = 0
        for entry in archive.infolist():
            name = entry.filename
            require(matches(r"[a-z][a-z0-9_-]{0,63}\.(json|md)", name), "Invalid evidence path")
            require(name not in result, "Duplicate evidence path")
            require(not stat.S_ISLNK(entry.external_attr >> 16), "Evidence symlink rejected")
            require(not entry.flag_bits & 1 and entry.file_size <= MAX_FILE, "Invalid evidence entry")
            total += entry.file_size
            require(total <= MAX_ARCHIVE, "Expanded evidence archive too large")
            result[name] = archive.read(entry)
    return result


def verify_configuration(config):
    require(set(config) == set(CONFIG_ENV) | {"secretVersions", "pricing"}, "Invalid configuration fields")
    require(matches(r"[a-z][a-z0-9-]{4,62}", config["projectId"]), "Invalid project")
    require(matches(r"[a-z]+-[a-z]+\d", config["region"]), "Invalid region")
    require(config["relayService"] in {"matrix-ai-relay", "matrix-ai-relay-production"}, "Production Relay required")
    require(matches(r"[a-z][a-z0-9-]{4,29}@" + re.escape(config["projectId"]) + r"\.iam\.gserviceaccount\.com",
                    config["relayServiceAccount"]), "Invalid production service account")
    require("preview" not in config["relayServiceAccount"], "Preview service account rejected")
    require(config["platformOrigin"] == "https://app.matrix-os.com", "Canonical production Platform required")
    gateway = config["cloudflareGatewayUrl"]
    require(matches(r"https://gateway\.ai\.cloudflare\.com/v1/[a-f0-9]{32}/[A-Za-z0-9_-]{1,64}/anthropic", gateway),
            "Official gateway required")
    require(not re.search(r"preview|staging|canary|dev", gateway, re.I), "Preview upstream rejected")
    require(set(config["secretVersions"]) == set(SECRETS), "Invalid secret version fields")
    require(all(matches(r"[1-9]\d{0,9}", value) for value in config["secretVersions"].values()), "Numeric secret versions required")
    pricing = config["pricing"]
    expected = {}
    for model, version, days in (("SONNET", "anthropic-2026-08-31-standard", 31),
                                 ("GLM", "cloudflare-2026-09-10-glm-flash", 31),
                                 ("JEV", "typesafe-jev-input-2026-09", 90)):
        prefix = "MATRIX_" + ("" if model == "JEV" else "FUNDED_") + model + "_PRICING_"
        expected.update({prefix + field: None for field in ("REVIEW_VERSION", "REVIEWED_AT", "VALID_THROUGH")})
        require(pricing[prefix + "REVIEW_VERSION"] == version, "Unsupported price review")
        review_window(pricing[prefix + "REVIEWED_AT"], pricing[prefix + "VALID_THROUGH"], days)
    require(set(pricing) == set(expected), "Invalid pricing fields")


def verify_evidence(body, receipt_hash, source, run, repository, stage):
    require(matches(r"[a-f0-9]{40}", source), "Exact source required")
    require(run["head_sha"] == source and run["head_branch"] == "main" and
            run["event"] == "workflow_dispatch" and run["conclusion"] == "success" and
            run["path"] == WORKFLOW and run["repository"]["full_name"] == repository and
            run["head_repository"]["full_name"] == repository, "Untrusted acceptance run")
    files = archive_files(body)
    require(matches(r"[a-f0-9]{64}", receipt_hash), "Reviewed receipt hash required")
    require(hashlib.sha256(files["receipt.json"]).hexdigest() == receipt_hash, "Receipt hash mismatch")
    receipt = read_json(files["receipt.json"])
    require(set(receipt) == {"schemaVersion", "sourceSha", "stage", "reviewedAt", "validThrough", "configuration", "checks"}
            | ({"candidate"} if receipt["stage"] == "production" else set()), "Invalid receipt fields")
    require(type(receipt["schemaVersion"]) is int and receipt["schemaVersion"] == 1 and
            receipt["sourceSha"] == source and receipt["stage"] == stage and stage in {"preview", "production"},
            "Evidence source or stage mismatch")
    review_window(receipt["reviewedAt"], receipt["validThrough"], 7)
    verify_configuration(receipt["configuration"])
    require(set(receipt["checks"]) == CHECKS, "Missing GA evidence")
    paths = {"receipt.json"}
    for check in receipt["checks"].values():
        require(set(check) == {"status", "path", "sha256"} and check["status"] == "passed", "GA gate not passed")
        path = check["path"]
        require(path != "receipt.json" and path in files and len(files[path]) > 0, "Evidence file missing")
        require(matches(r"[a-f0-9]{64}", check["sha256"]) and
                hashlib.sha256(files[path]).hexdigest() == check["sha256"], "Evidence hash mismatch")
        paths.add(path)
    require(set(files) == paths, "Unreferenced evidence files")
    if stage == "production":
        candidate = receipt["candidate"]
        require(set(candidate) == {"revision", "image"}, "Invalid candidate fields")
        config = receipt["configuration"]
        require(matches(re.escape(config["relayService"]) + r"-[a-z0-9-]{1,40}", candidate["revision"]), "Invalid candidate revision")
        require(matches(re.escape(config["region"] + "-docker.pkg.dev/" + config["projectId"])
                        + r"/[a-z0-9-]+/matrix-ai-relay@sha256:[a-f0-9]{64}", candidate["image"]), "Pinned candidate image required")
    return receipt


def verify_candidate(receipt, candidate):
    require(receipt["stage"] == "production" and receipt["candidate"] == candidate, "Candidate evidence mismatch")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def fetch_bytes(url, limit, token=None, accept="application/vnd.github+json"):
    headers = {"Accept": accept, "User-Agent": "matrix-funded-release-gate"}
    if token:
        headers["Authorization"] = "Bearer " + token
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, headers=headers), timeout=10) as response:
        body = response.read(limit + 1)
        require(len(body) <= limit, "Response exceeds evidence limit")
        return body


def github_api(path):
    require(matches(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", os.environ["GITHUB_REPOSITORY"]), "Invalid repository")
    return read_json(fetch_bytes("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + path,
                                MAX_FILE, os.environ["GH_TOKEN"]))


def download_archive(path):
    url = "https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + path
    try:
        return fetch_bytes(url, MAX_ARCHIVE, os.environ["GH_TOKEN"], "application/octet-stream")
    except urllib.error.HTTPError as error:
        require(error.code in {302, 303}, "Artifact download failed")
        location = error.headers.get("Location", "")
        parsed = urllib.parse.urlsplit(location)
        require(parsed.scheme == "https" and parsed.hostname is not None and
                (parsed.hostname.endswith(".blob.core.windows.net") or parsed.hostname.endswith(".actions.githubusercontent.com")
                 or parsed.hostname == "release-assets.githubusercontent.com") and
                parsed.username is None and parsed.password is None and parsed.port in {None, 443}, "Untrusted artifact redirect")
        # Never forward the GitHub token to the signed blob/release download.
        return fetch_bytes(location, MAX_ARCHIVE, accept="application/octet-stream")


def load_evidence(stage):
    run_id = os.environ["MATRIX_FUNDED_AI_ACCEPTANCE_RUN_ID"]
    require(matches(r"[1-9]\d{0,19}", run_id), "Reviewed acceptance run required")
    run = github_api("/actions/runs/" + run_id)
    require(run.get("status") == "completed", "Completed acceptance run required")
    require(run.get("conclusion") == "success", "Successful acceptance run required")
    artifacts = github_api("/actions/runs/" + run_id + "/artifacts?per_page=100")
    require(artifacts["total_count"] <= 100, "Too many acceptance artifacts")
    selected = [item for item in artifacts["artifacts"] if item["name"] == ARTIFACT]
    require(len(selected) == 1 and not selected[0]["expired"] and selected[0]["size_in_bytes"] <= MAX_ARCHIVE,
            "Current acceptance artifact required")
    artifact_id = selected[0]["id"]
    require(type(artifact_id) is int and artifact_id > 0, "Invalid artifact ID")
    body = download_archive("/actions/artifacts/" + str(artifact_id) + "/zip")
    return verify_evidence(body, os.environ["MATRIX_FUNDED_AI_ACCEPTANCE_RECEIPT_SHA256"],
                           os.environ["GITHUB_SHA"], run, os.environ["GITHUB_REPOSITORY"], stage)


def emit_env(values):
    # All values are validated scalar IDs/URLs; GitHub command injection is rejected.
    require(all(isinstance(value, str) and "\n" not in value and "\r" not in value for value in values.values()), "Invalid environment output")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(key + "=" + value + "\n")


def configuration():
    environment = os.environ["DEPLOY_ENVIRONMENT"]
    if environment == "staging":
        emit_env({"GATEWAY_TOKEN_SECRET": "cloudflare-ai-gateway-token", "WORKERS_TOKEN_SECRET": "cloudflare-workers-ai-token-preview",
                  "CONTROL_TOKEN_SECRET": "ai-relay-control-token", "METADATA_SECRET_SECRET": "ai-relay-metadata-secret",
                  **{prefix + "_VERSION": "latest" for prefix, _ in SECRETS.values()}})
        return
    require(environment == "production" and os.environ["GITHUB_REF"] == "refs/heads/main", "Production requires reviewed main source")
    stage = "production" if os.environ.get("PROMOTE") == "true" else "preview"
    receipt = load_evidence(stage)
    config = receipt["configuration"]
    require(all(os.environ.get(key) == config[field] for field, key in CONFIG_ENV.items()) and
            all(os.environ.get(key) == value for key, value in config["pricing"].items()), "Reviewed deployment configuration mismatch")
    values = {}
    for key, (prefix, secret) in SECRETS.items():
        values[prefix + "_SECRET"] = secret
        values[prefix + "_VERSION"] = config["secretVersions"][key]
    emit_env(values)


def cloud_json(kind, name):
    require(matches(r"[a-z][a-z0-9-]{0,62}", name), "Invalid cloud resource")
    result = subprocess.run(["gcloud", "run", kind, "describe", name, "--project", os.environ["GCP_PROJECT_ID"],
                             "--region", os.environ["GCP_REGION"], "--format=json", "--quiet"],
                            capture_output=True, timeout=30, check=True)
    require(len(result.stdout) <= MAX_FILE, "Cloud metadata too large")
    return read_json(result.stdout)


def deployment_preflight():
    require(os.environ["DEPLOY_ENVIRONMENT"] == "production" and os.environ["GITHUB_REF"] == "refs/heads/main", "Production main required")
    service = cloud_json("services", os.environ["AI_RELAY_CLOUD_RUN_SERVICE"])
    # gcloud rejects --no-traffic on service creation. A separately prepared
    # inert baseline is necessary; never bootstrap an enabled first revision.
    require(service.get("status", {}).get("latestReadyRevisionName"), "Existing safe production baseline required")


def candidate_isolation():
    service = cloud_json("services", os.environ["AI_RELAY_CLOUD_RUN_SERVICE"])
    status = service["status"]
    targets = [target for target in status["traffic"] if target.get("tag") == "candidate"]
    require(len(targets) == 1 and targets[0].get("revisionName") == os.environ["CANDIDATE_REVISION"], "Candidate tag mismatch")
    revision_name = targets[0]["revisionName"]
    for target in status["traffic"]:
        resolved = status.get("latestReadyRevisionName") if target.get("latestRevision") else target.get("revisionName")
        require(resolved != revision_name or target.get("percent", 0) == 0, "Candidate receives default traffic")
    revision = cloud_json("revisions", revision_name)
    container, = revision["spec"]["containers"]
    require(container["image"] == os.environ["IMAGE_DIGEST"] and
            revision["metadata"]["labels"].get("matrix-source-sha") == os.environ["GITHUB_SHA"], "Candidate provenance mismatch")


def promotion():
    require(os.environ["DEPLOY_ENVIRONMENT"] == "production" and os.environ["GITHUB_REF"] == "refs/heads/main", "Production main required")
    receipt = load_evidence("production")
    config = receipt["configuration"]
    require(all(os.environ.get(key) == config[field] for field, key in CONFIG_ENV.items()) and
            all(os.environ.get(key) == value for key, value in config["pricing"].items()), "Reviewed deployment configuration mismatch")
    service = cloud_json("services", config["relayService"])
    targets = [target for target in service["status"]["traffic"] if target.get("tag") == "candidate"]
    require(len(targets) == 1, "Unique candidate tag required")
    target = targets[0]
    revision = cloud_json("revisions", target["revisionName"])
    container, = revision["spec"]["containers"]
    require(not container.get("command") and not container.get("args") and
            not container.get("volumeMounts") and not revision["spec"].get("volumes"), "Candidate runtime overrides rejected")
    verify_candidate(receipt, {"revision": target["revisionName"], "image": container["image"]})
    require(revision["metadata"]["labels"].get("matrix-source-sha") == receipt["sourceSha"] and
            revision["spec"]["serviceAccountName"] == config["relayServiceAccount"] and
            any(item["type"] == "Ready" and item["status"] == "True" for item in revision["status"]["conditions"]),
            "Candidate source/account/readiness mismatch")
    annotations = revision["metadata"].get("annotations", {})
    limits = container.get("resources", {}).get("limits", {})
    require(revision["spec"].get("containerConcurrency") == 32 and revision["spec"].get("timeoutSeconds") == 900 and
            limits.get("cpu") in {"1", "1000m"} and limits.get("memory") == "512Mi" and
            annotations.get("autoscaling.knative.dev/maxScale") == "3" and
            annotations.get("autoscaling.knative.dev/minScale", "0") == "0", "Candidate resource bounds mismatch")
    entries = container["env"]
    require(len({item["name"] for item in entries}) == len(entries), "Duplicate candidate environment")
    env = {item["name"]: item for item in entries}
    expected = {**FIXED_ENV,
                "PLATFORM_INTERNAL_URL": config["platformOrigin"], "CLOUDFLARE_AI_GATEWAY_URL": config["cloudflareGatewayUrl"],
                **config["pricing"]}
    require(all(env.get(key, {}).get("value") == value for key, value in expected.items()), "Candidate runtime configuration mismatch")
    for key, (_, secret) in SECRETS.items():
        name = {"gatewayToken": "CLOUDFLARE_AI_GATEWAY_TOKEN", "workersToken": "CLOUDFLARE_WORKERS_AI_TOKEN",
                "controlToken": "AI_RELAY_CONTROL_TOKEN", "metadataSecret": "AI_RELAY_METADATA_SECRET"}[key]
        require(env.get(name, {}).get("valueFrom", {}).get("secretKeyRef") ==
                {"name": secret, "key": config["secretVersions"][key]}, "Candidate secret mismatch")
    require(set(env) == set(expected) | {"CLOUDFLARE_AI_GATEWAY_TOKEN", "CLOUDFLARE_WORKERS_AI_TOKEN",
                                        "AI_RELAY_CONTROL_TOKEN", "AI_RELAY_METADATA_SECRET"}, "Unreviewed candidate environment")
    require(matches(r"https://candidate---[a-z0-9-]+\.a\.run\.app", target["url"]), "Invalid candidate URL")
    emit_env({"CANDIDATE_URL": target["url"], "CANDIDATE_REVISION": target["revisionName"]})


def import_evidence():
    require(os.environ["GITHUB_REF"] == "refs/heads/main", "Evidence import requires main")
    asset_id, archive_hash = os.environ["EVIDENCE_ASSET_ID"], os.environ["EVIDENCE_ARCHIVE_SHA256"]
    require(matches(r"[1-9]\d{0,19}", asset_id) and matches(r"[a-f0-9]{64}", archive_hash), "Invalid evidence asset pin")
    body = download_archive("/releases/assets/" + asset_id)
    require(hashlib.sha256(body).hexdigest() == archive_hash, "Evidence asset hash mismatch")
    files = archive_files(body)
    # Structural validation only; administrator review pins the subsequent run and receipt.
    receipt = read_json(files["receipt.json"])
    run = {"head_sha": os.environ["GITHUB_SHA"], "head_branch": "main", "event": "workflow_dispatch",
           "conclusion": "success", "path": WORKFLOW,
           "repository": {"full_name": os.environ["GITHUB_REPOSITORY"]},
           "head_repository": {"full_name": os.environ["GITHUB_REPOSITORY"]}}
    verify_evidence(body, hashlib.sha256(files["receipt.json"]).hexdigest(), os.environ["GITHUB_SHA"], run,
                    os.environ["GITHUB_REPOSITORY"], receipt["stage"])
    os.mkdir("funded-ai-evidence", 0o700)
    for name, content in files.items():
        with open("funded-ai-evidence/" + name, "xb") as output:
            output.write(content)


if __name__ == "__main__":
    try:
        {"configuration": configuration, "promotion": promotion, "import": import_evidence,
         "deployment-preflight": deployment_preflight, "candidate-isolation": candidate_isolation}[sys.argv[1]]()
    except (KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError, zipfile.BadZipFile):
        print("Funded Relay release evidence/configuration verification failed; production remains blocked.", file=sys.stderr)
        sys.exit(1)
