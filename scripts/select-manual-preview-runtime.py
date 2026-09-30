#!/usr/bin/env python3
"""Select a trusted main dispatch only after checking its bundled source commit.

The workflow's head SHA identifies main, not the PR checked out by its gate.
Download one bounded bundle archive; read only release.json, never extract it.
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


def download(path, destination):
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
                if size > MAX_ARCHIVE:
                    raise ValueError("Artifact exceeds download bound")
                output.write(chunk)
        if process.wait(timeout=max(1, deadline - time.monotonic())) != 0:
            raise ValueError("Artifact download failed")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()


def verify_release(path, pr, expected):
    with zipfile.ZipFile(path) as archive:
        entries = [info for info in archive.infolist() if info.filename == "release.json"]
        if len(entries) != 1:
            raise ValueError("Missing unique release metadata")
        entry = entries[0]
        file_type = (entry.external_attr >> 16) & 0o170000
        if entry.is_dir() or file_type not in (0, 0o100000) or not 0 < entry.file_size <= MAX_RELEASE:
            raise ValueError("Invalid release metadata file")
        release = json.loads(archive.read(entry))
    version_pattern = rf"v\d{{4}}\.\d{{2}}\.\d{{2}}-pr{pr}-[1-9]\d*-[1-9]\d*-{expected[:7]}"
    if not isinstance(release, dict) or not (
        release.get("schemaVersion") == 1
        and release.get("kind") == "matrix-os-host-bundle"
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
    runs = api(f"repos/{repository}/actions/workflows/preview-vps.yml/runs?event=workflow_dispatch&status=success&branch=main&per_page=10")["workflow_runs"]
    for run in runs[:10]:
        if not (
            run.get("event") == "workflow_dispatch" and run.get("head_branch") == "main"
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and run.get("head_repository", {}).get("full_name") == repository
            and type(run.get("id")) is int and run["id"] > 0
        ):
            continue
        items = api(f"repos/{repository}/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
        route = artifact(items, f"preview-runtime-access-{pr}", 1024 ** 2)
        bundle = artifact(items, f"preview-bundle-{pr}", MAX_ARCHIVE)
        if route is None or bundle is None:
            continue
        # Fail closed if the latest deployed candidate for this PR is stale.
        # Download at most one archive, and remove it on every exit path.
        with tempfile.TemporaryDirectory(prefix="preview-provenance-") as directory:
            path = os.path.join(directory, "bundle.zip")
            download(f"repos/{repository}/actions/artifacts/{bundle['id']}/zip", path)
            verify_release(path, pr, expected)
        return run["id"]
    raise ValueError("No trusted exact-head manual preview deployment found")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Invalid arguments")
        print(choose(*sys.argv[1:]))
    except (ValueError, KeyError, TypeError, OSError, TimeoutError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        # Do not print external stderr, URLs, artifact contents, or credentials.
        print(f"Preview provenance check failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
