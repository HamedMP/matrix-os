#!/usr/bin/env bash
# Sourced by the root-only installer; these guards cover the whole install.
trial_lock_install() {
  local trial_lock_root="$1"
  [[ ! -L "$trial_lock_root/.install.lock" ]] || { echo 'Refusing a symlink installer lock.' >&2; return 1; }
  exec 9>"$trial_lock_root/.install.lock"
  flock --nonblock --exclusive 9 || { echo 'Another trial installation is active.' >&2; return 1; }
}

trial_require_stopped() {
  local trial_unit trial_service_state trial_service_status
  for trial_unit in matrix-memory-trial-hindsight.service matrix-memory-trial-openviking.service; do
    if trial_service_state=$(timeout 10 systemctl is-active "$trial_unit" 2>/dev/null); then
      echo 'Stop the native trial services before reinstalling their environments.' >&2
      return 1
    else
      trial_service_status=$?
      if [[ "$trial_service_status" != 3 && "$trial_service_status" != 4 ]] ||
         [[ "$trial_service_state" != inactive && "$trial_service_state" != failed && "$trial_service_state" != unknown ]]; then
        echo 'Trial services must be fully stopped and inspectable before installation.' >&2
        return 1
      fi
    fi
  done
}
