#!/usr/bin/env python3
"""Select a trusted main dispatch only after proving its exact preview source.

The workflow's head SHA identifies main, not the PR checked out by its gate.
Search artifacts belonging to this PR. Verify an installed provenance artifact
for pinned deployments, or the legacy bounded bundle; never extract an archive.
"""
import json
import os
import re
import select
import subprocess
import sys
import tempfile
import time
import zipfile

MAX_ARCHIVE = 2 * 1024 ** 3
MAX_RELEASE = 64 * 1024


def api(path):
    result = subprocess.run(["gh", "api", path], capture_output=True, timeout=30, check=True)
    if len(result.stdout) > 2 * 1024 ** 2:
        raise ValueError("API response exceeds bound")
    return json.loads(result.stdout)


def artifact(items, name, maximum):
    matches = [item for item in items if item.get("name") == name and item.get("expired") is False]
    if len(matches) != 1:
        return None
    item = matches[0]
    if type(item.get("id")) is not int or item["id"] <= 0:
        return None
    if type(item.get("size_in_bytes")) is not int or not 0 < item["size_in_bytes"] <= maximum:
        return None
    return item


def download(path, destination, maximum=MAX_ARCHIVE):
    # Limit both disk consumption and wall time while gh follows GitHub's signed
    # artifact redirect. No auth values, URLs, or bundle contents are logged.
    process = subprocess.Popen(["gh", "api", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 180
    size = 0
    try:
        with open(destination, "xb") as output:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Artifact download timed out")
                readable, _, _ = select.select([process.stdout], [], [], min(remaining, 30))
                if not readable:
                    raise TimeoutError("Artifact download stalled")
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > maximum:
                    raise ValueError("Artifact exceeds download bound")
                output.write(chunk)
        if process.wait(timeout=max(1, deadline - time.monotonic())) != 0:
            raise ValueError("Artifact download failed")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()


def verify_release(path, pr, expected, installed=False):
    with zipfile.ZipFile(path) as archive:
        name = "preview-runtime-provenance.json" if installed else "release.json"
        entries = [info for info in archive.infolist() if info.filename == name]
        if len(entries) != 1:
            raise ValueError("Missing unique release metadata")
        entry = entries[0]
        file_type = (entry.external_attr >> 16) & 0o170000
        if entry.is_dir() or file_type not in (0, 0o100000) or not 0 < entry.file_size <= MAX_RELEASE:
            raise ValueError("Invalid release metadata file")
        release = json.loads(archive.read(entry))
    suffix = r"(?:-[1-9]\d*-[1-9]\d*)?" if installed else r"-[1-9]\d*-[1-9]\d*"
    version_pattern = rf"v\d{{4}}\.\d{{2}}\.\d{{2}}-pr{pr}{suffix}-{expected[:7]}"
    if not isinstance(release, dict) or not (
        type(release.get("schemaVersion")) is int and release["schemaVersion"] == 1
        and release.get("kind") == ("matrix-os-preview-runtime" if installed else "matrix-os-host-bundle")
        and (not installed or release.get("handle") == f"pr-{pr}")
        and release.get("channel") == "none"
        and release.get("gitCommit") == expected
        and isinstance(release.get("version"), str)
        and re.fullmatch(version_pattern, release["version"])
    ):
        raise ValueError("Bundle does not match the requested preview head")


def choose(repository, pr, expected):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid repository")
    if not re.fullmatch(r"[1-9][0-9]{0,8}", pr) or not re.fullmatch(r"[a-f0-9]{40}", expected):
        raise ValueError("Invalid preview target")
    # PR-specific artifact lookup prevents other PRs' dispatches hiding this runtime.
    # Both result pages and distinct runs are bounded; API calls retain their timeout.
    seen = set()
    for page in range(1, 6):
        candidates = api(f"repos/{repository}/actions/artifacts?name=preview-runtime-access-{pr}&per_page=100&page={page}")["artifacts"]
        for candidate in candidates:
            if artifact([candidate], f"preview-runtime-access-{pr}", 1024 ** 2) is None:
                continue
            run_id = candidate.get("workflow_run", {}).get("id")
            if type(run_id) is not int or run_id <= 0 or run_id in seen:
                continue
            seen.add(run_id)
            run = api(f"repos/{repository}/actions/runs/{run_id}")
            if not (
                run.get("id") == run_id and run.get("event") == "workflow_dispatch"
                and run.get("head_branch") == "main" and run.get("status") == "completed"
                and run.get("conclusion") == "success"
                and run.get("head_repository", {}).get("full_name") == repository
                and isinstance(run.get("path"), str)
                and run["path"].split("@")[0] == ".github/workflows/preview-vps.yml"
            ):
                continue
            items = api(f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
            route = artifact(items, f"preview-runtime-access-{pr}", 1024 ** 2)
            if route is None or route["id"] != candidate["id"]:
                continue
            installed = artifact(items, f"preview-runtime-provenance-{pr}", 1024 ** 2)
            bundle = artifact(items, f"preview-bundle-{pr}", MAX_ARCHIVE)
            selected = installed or bundle
            if selected is None:
                raise ValueError("Latest deployed preview has no verifiable source metadata")
            # Never fall back past a stale latest deployed candidate for this PR.
            # Download at most one archive and clean it on every exit path.
            with tempfile.TemporaryDirectory(prefix="preview-provenance-") as directory:
                path = os.path.join(directory, "proof.zip")
                download(f"repos/{repository}/actions/artifacts/{selected['id']}/zip", path,
                         1024 ** 2 if installed else MAX_ARCHIVE)
                verify_release(path, pr, expected, installed=installed is not None)
            return run_id
        if len(candidates) < 100:
            break
    raise ValueError("No trusted exact-head manual preview deployment found")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Invalid arguments")
        print(choose(*sys.argv[1:]))
    except (ValueError, KeyError, TypeError, OSError, TimeoutError, subprocess.SubprocessError, zipfile.BadZipFile, RecursionError) as error:
        # Do not print external stderr, URLs, artifact contents, or credentials.
        print(f"Preview provenance check failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
