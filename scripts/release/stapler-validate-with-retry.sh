#!/usr/bin/env bash
# Validate the stapled notarization ticket of a macOS app, retrying transient
# failures. `stapler validate` looks the ticket up on Apple's CloudKit service,
# which occasionally drops the connection ("The network connection was lost.",
# exit 68) on an app that was notarized moments earlier. A ticket that is really
# missing fails every attempt, so the build still fails.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <path-to-app>" >&2
  exit 2
fi

app_path="$1"
attempts="${STAPLER_VALIDATE_ATTEMPTS:-4}"
delay="${STAPLER_VALIDATE_RETRY_DELAY_SECONDS:-15}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if xcrun stapler validate "$app_path"; then
    exit 0
  else
    status=$?
  fi
  echo "stapler validate attempt ${attempt}/${attempts} failed with exit ${status}" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$((delay * attempt))"
  fi
done

echo "stapler validate failed after ${attempts} attempts" >&2
exit 1
