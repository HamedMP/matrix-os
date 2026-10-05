#!/usr/bin/env bash
# Only installs isolated services; never promotes/deploys a Matrix release or changes gateway routes.
set -euo pipefail
umask 077
[[ "${1:-}" == "--private-owner-trial" && "$#" == 1 && "$EUID" == 0 ]] || { echo 'Requires an authorized private owner trial VPS.' >&2; exit 1; }
trial_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v timeout >/dev/null
command -v python3 >/dev/null
command -v systemctl >/dev/null
command -v flock >/dev/null
source "$trial_script_dir/install-runtime.sh"
id matrix >/dev/null
for trial_dir in /opt/matrix-memory-trial /etc/matrix/memory-trial /var/lib/matrix-memory-trial; do
  [[ ! -L "$trial_dir" ]] || { echo 'Refusing a symlink trial root.' >&2; exit 1; }
done
install -d -m 0755 -o root -g root /opt/matrix-memory-trial
trial_lock_install /opt/matrix-memory-trial
install -d -m 0750 -o root -g matrix /etc/matrix/memory-trial
install -d -m 0700 -o matrix -g matrix /var/lib/matrix-memory-trial /var/lib/matrix-memory-trial/cache
# The operator must provision owner-local Postgres + pgvector and a protected operator.json first.
[[ -f /etc/matrix/memory-trial/operator.json && ! -L /etc/matrix/memory-trial/operator.json ]] || { echo 'Prepare the protected operator configuration first.' >&2; exit 1; }
timeout 30 python3 "$trial_script_dir/configure.py" --private-owner-trial
trial_require_stopped
# Repair group readability on retries without modifying protected configuration contents.
for trial_config in /etc/matrix/memory-trial/hindsight.env /etc/matrix/memory-trial/ov.conf /etc/matrix/memory-trial/configuration.receipt.json; do
  [[ -f "$trial_config" && ! -L "$trial_config" ]] || { echo 'Trial configuration must be a regular file.' >&2; exit 1; }
  chown root:matrix "$trial_config"
  chmod 0640 "$trial_config"
done
for trial_engine in hindsight openviking; do
  trial_venv="/opt/matrix-memory-trial/${trial_engine}"
  [[ ! -L "$trial_venv" ]] || { echo 'Refusing a symlink environment.' >&2; exit 1; }
  if [[ ! -d "$trial_venv" ]]; then timeout 60 python3 -m venv "$trial_venv"; fi
  timeout 900 "$trial_venv/bin/python" -m pip install --disable-pip-version-check --timeout 30 --retries 2 -r "$trial_script_dir/${trial_engine}-requirements.txt"
  # Independent environments prevent engine dependency conflicts; receipts record the resolved versions.
  trial_requirements_receipt="/opt/matrix-memory-trial/${trial_engine}-installed-requirements.txt"
  trial_reranking_receipt="/opt/matrix-memory-trial/${trial_engine}-reranking-verification.json"
  timeout 40 python3 -B "$trial_script_dir/receipts.py" "$trial_requirements_receipt" "$trial_venv/bin/python" -m pip freeze
  # Verifies the actual pinned package capability without any cloud credentials or calls.
  timeout 40 python3 -B "$trial_script_dir/receipts.py" "$trial_reranking_receipt" "$trial_venv/bin/python" -B "$trial_script_dir/verify-reranking.py" "$trial_engine"
  # Public package runtime only: preserve root ownership; matrix gets read/execute, never write.
  # Do not dereference interpreter symlinks and change permissions outside the trial environment.
  timeout 120 chgrp -R -h matrix "$trial_venv"
  timeout 120 chmod -R g+rX,g-w,o-rwx "$trial_venv"
  chown root:matrix "$trial_requirements_receipt" "$trial_reranking_receipt"
  chmod 0640 "$trial_requirements_receipt" "$trial_reranking_receipt"
done
install -m 0644 "$trial_script_dir/hindsight.service" /etc/systemd/system/matrix-memory-trial-hindsight.service
install -m 0644 "$trial_script_dir/openviking.service" /etc/systemd/system/matrix-memory-trial-openviking.service
timeout 30 systemctl daemon-reload
timeout 120 systemctl enable --now matrix-memory-trial-hindsight.service matrix-memory-trial-openviking.service
echo 'Native trial engines started on loopback. Run readiness and synthetic ingestion checks before enabling imports.'
