#!/usr/bin/env bash
# Resolve the preview platform origin for CI jobs that hold the preview
# operator secret. Prints the normalized origin on success; refuses (exit 1,
# nothing on stdout) anything that is not a bare HTTPS origin or that names a
# production Matrix OS host, so a misconfigured PREVIEW_PUBLIC_URL can never
# send a preview bundle or the preview PLATFORM_SECRET to production.
#
# Env: PREVIEW_PUBLIC_URL (optional, default https://preview.matrix-os.com)
set -euo pipefail

url="${PREVIEW_PUBLIC_URL:-https://preview.matrix-os.com}"
url="${url%/}"

if ! [[ "$url" =~ ^https://[A-Za-z0-9.-]{1,253}$ ]]; then
  echo "PREVIEW_PUBLIC_URL must be a bare HTTPS origin." >&2
  exit 1
fi

host="${url#https://}"
host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
host="${host%.}"
case "$host" in
  matrix-os.com|www.matrix-os.com|app.matrix-os.com|api.matrix-os.com)
    echo "PREVIEW_PUBLIC_URL must not be a production Matrix OS host." >&2
    exit 1
    ;;
esac

printf 'https://%s\n' "$host"
