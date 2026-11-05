"""Trusted main-controller validation for an immutable Relay release source."""
import re

PROVENANCE_FILE = "release-provenance.json"
CI_WORKFLOW = ".github/workflows/ci.yml"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value) is not None


def positive(value):
    return type(value) is int and 0 < value < 10 ** 20


def validate_ancestry(api, release, controller):
    require(sha(release) and sha(controller), "Exact source/controller required")
    require(api("/commits/" + controller)["sha"] == controller, "Controller commit mismatch")
    compare = api("/compare/" + release + "..." + controller + "?per_page=1")
    require(compare["status"] in {"ahead", "identical"} and
            compare["base_commit"]["sha"] == release and
            compare["merge_base_commit"]["sha"] == release, "Release source is not a controller ancestor")


def validate_source(api, env):
    controller = env["GITHUB_SHA"]
    release = env.get("REQUESTED_RELEASE_SOURCE_SHA") or controller
    repository = env["GITHUB_REPOSITORY"]
    require(env["GITHUB_REF"] == "refs/heads/main" and sha(controller) and sha(release),
            "Release source requires a full SHA and main controller")
    validate_ancestry(api, release, controller)
    workflow = api("/actions/workflows/ci.yml")
    require(positive(workflow["id"]) and workflow["path"] == CI_WORKFLOW and workflow["state"] == "active",
            "Canonical CI workflow required")
    runs = api("/actions/workflows/" + str(workflow["id"]) + "/runs?head_sha=" + release +
               "&branch=main&event=push&per_page=10")
    require(type(runs["total_count"]) is int and 0 < runs["total_count"] <= 10 and
            len(runs["workflow_runs"]) == runs["total_count"], "Bounded exact-source CI history required")
    require(all(positive(run.get("id")) for run in runs["workflow_runs"]), "Invalid CI run identity")
    run = max(runs["workflow_runs"], key=lambda item: item["id"])
    require(run["workflow_id"] == workflow["id"] and run["path"] == CI_WORKFLOW and
            run["head_sha"] == release and run["head_branch"] == "main" and run["event"] == "push" and
            run["repository"]["full_name"] == repository and run["head_repository"]["full_name"] == repository and
            run["status"] == "completed" and run["conclusion"] == "success" and positive(run["run_attempt"]) and
            run["display_title"] == "CI coverage-v1 · " + release, "Successful exact-source main CI required")
    # A green routing or docs-only wrapper is not proof that workload tests ran.
    jobs = api("/actions/runs/" + str(run["id"]) + "/attempts/" + str(run["run_attempt"]) + "/jobs?per_page=100")
    require(type(jobs["total_count"]) is int and 1 <= jobs["total_count"] <= 100 and
            len(jobs["jobs"]) == jobs["total_count"], "Bounded current-attempt CI jobs required")
    required = {"CI Results": None, "Type Check": "Type check all packages", **{
        "Unit Tests (" + str(n) + "/4)": "bun run test -- --shard=" + str(n) + "/4" for n in range(1, 5)}}
    for name, step in required.items():
        selected = [job for job in jobs["jobs"] if job["name"] == name]
        require(len(selected) == 1 and selected[0]["status"] == "completed" and
                selected[0]["conclusion"] == "success", "Required hosted CI workload did not pass")
        if step:
            require(any(step in item["name"] and item["conclusion"] == "success"
                        for item in selected[0].get("steps", [])), "Required hosted CI test step did not execute")
    return {"controllerSha": controller, "releaseSourceSha": release,
            "sourceCiRunId": run["id"], "sourceCiRunAttempt": run["run_attempt"]}


def release_source(env):
    value = env.get("RELEASE_SOURCE_SHA") or env["GITHUB_SHA"]
    require(sha(value), "Exact release source required")
    return value


def make_provenance(env, receipt_hash, archive_hash):
    result = {"schemaVersion": 1, "controllerSha": env["GITHUB_SHA"],
              "releaseSourceSha": release_source(env), "repository": env["GITHUB_REPOSITORY"],
              "workflowRunId": int(env["GITHUB_RUN_ID"]), "workflowRunAttempt": int(env["GITHUB_RUN_ATTEMPT"]),
              "sourceCiRunId": int(env["SOURCE_CI_RUN_ID"]), "sourceCiRunAttempt": int(env["SOURCE_CI_RUN_ATTEMPT"]),
              "receiptSha256": receipt_hash, "inputArchiveSha256": archive_hash}
    require(sha(result["controllerSha"]) and all(positive(result[key]) for key in
            ("workflowRunId", "workflowRunAttempt", "sourceCiRunId", "sourceCiRunAttempt")), "Invalid import provenance")
    return result


def verify_provenance(value, env, run, receipt_hash):
    require(set(value) == {"schemaVersion", "controllerSha", "releaseSourceSha", "repository", "workflowRunId",
            "workflowRunAttempt", "sourceCiRunId", "sourceCiRunAttempt", "receiptSha256", "inputArchiveSha256"},
            "Invalid import provenance fields")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and sha(value["controllerSha"]) and
            value["controllerSha"] == run["head_sha"] and value["releaseSourceSha"] == release_source(env) and
            value["repository"] == env["GITHUB_REPOSITORY"] and
            all(positive(value[key]) for key in ("workflowRunId", "workflowRunAttempt", "sourceCiRunId", "sourceCiRunAttempt")) and
            value["workflowRunId"] == run["id"] and value["workflowRunAttempt"] == run["run_attempt"] and
            value["sourceCiRunId"] == int(env["SOURCE_CI_RUN_ID"]) and
            value["sourceCiRunAttempt"] == int(env["SOURCE_CI_RUN_ATTEMPT"]) and
            value["receiptSha256"] == receipt_hash and
            isinstance(value["inputArchiveSha256"], str) and re.fullmatch(r"[a-f0-9]{64}", value["inputArchiveSha256"]),
            "Import provenance does not match actual run/source/receipt")
