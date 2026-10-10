#!/bin/bash
# Recurring crash/orphan cleanup, never delete a container within its deadline.
set -euo pipefail
now=$(date +%s)
while read -r container; do
  [[ $container =~ ^[a-f0-9]{12,64}$ ]] || continue
  created=$(docker inspect --format '{{.Created}}' "$container")
  created_epoch=$(date --date="$created" +%s)
  if (( now - created_epoch > 2700 )); then docker rm --force "$container"; fi
done < <(docker ps --all --quiet --filter label=matrix-ci.disposable=true)
python3 - <<'PY'
import os, shutil, stat, time
from pathlib import Path
root = Path('/var/lib/matrix-ci/results')
if root.is_symlink() or not root.is_dir():
    raise SystemExit(0)
rows = []
for path in root.iterdir():
    info = path.lstat()
    if path.name.startswith('run.') and stat.S_ISDIR(info.st_mode):
        rows.append((info.st_mtime, path))
rows.sort()
for index, (mtime, path) in enumerate(rows):
    # Active runs are always protected; seven-day TTL and 20-result cap.
    if time.time() - mtime > 2700 and (time.time() - mtime > 7 * 86400 or index < len(rows) - 20):
        shutil.rmtree(path)
PY
