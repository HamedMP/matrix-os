import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// OSC 7501 is parsed by the pinned core, including base64 message fields.
// This private command changes no user startup files or global installations.
const REPORTER = String.raw`#!/bin/sh
set -eu
case "${"${1-}"}" in idle|working|done|blocked|error) ;; *) echo 'Usage: matrix-status idle|working|done|blocked|error [message]' >&2; exit 2 ;; esac
[ "$#" -le 2 ] || exit 2
message=${"${2-}"}
[ "$(printf '%s' "$message" | wc -c | tr -d ' ')" -le 200 ] || { echo 'matrix-status: message exceeds 200 bytes' >&2; exit 2; }
encoded=$(printf '%s' "$message" | base64 | tr -d '\r\n')
printf '\033]7501;state=%s:msg=%s\033\\' "$1" "$encoded"
`;

export async function installLocalStatusReporter(dataDir: string): Promise<string> {
  const bin = join(dataDir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const temporary = join(bin, `.matrix-status-${randomUUID()}`);
  try {
    await writeFile(temporary, REPORTER, { flag: "wx", mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, join(bin, "matrix-status"));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
  return bin;
}
