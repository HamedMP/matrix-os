#!/usr/bin/env bash
# Resolve the preview platform origin for CI jobs that hold the preview
# operator secret. This is an ALLOWLIST: it prints the normalized origin only
# for the preview host or the dedicated preview Cloud Run service origin, and
# refuses (exit 1, nothing on stdout) everything else -- production hosts,
# production Cloud Run origins, IP literals, ports, userinfo, paths, queries,
# fragments, and trailing dots -- so a misconfigured PREVIEW_PUBLIC_URL can
# never send a preview bundle or the preview PLATFORM_SECRET anywhere else.
#
# Env: PREVIEW_PUBLIC_URL (default https://preview.matrix-os.com when unset;
#      set-but-empty is refused)
set -euo pipefail

refuse() {
  echo "PREVIEW_PUBLIC_URL must be https://preview.matrix-os.com or the matrix-platform-preview Cloud Run origin." >&2
  exit 1
}

url="${PREVIEW_PUBLIC_URL-https://preview.matrix-os.com}"
# Allow exactly one optional trailing slash (a bare origin), nothing else.
url="${url%/}"
url="$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')"

[[ "$url" == https://* ]] || refuse
host="${url#https://}"

preview_host='preview\.matrix-os\.com'
preview_run_app='(pr-[1-9][0-9]{0,8}---)?matrix-platform-preview-[a-z0-9]{1,32}-[a-z0-9]{1,8}\.a\.run\.app'
if ! [[ "$host" =~ ^(${preview_host}|${preview_run_app})$ ]]; then
  refuse
fi

printf 'https://%s\n' "$host"
