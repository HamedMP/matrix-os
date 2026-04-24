#!/usr/bin/env node
// Restore execute bits on node-pty's prebuilt spawn-helper binary.
//
// pnpm (at least 10.6.x) occasionally strips execute bits when unpacking
// prebuilt tarballs, which makes every `posix_spawnp` call from node-pty
// fail with "posix_spawnp failed" and no errno. The gateway's terminal
// sessions are the main victim -- the shell can't start, so the browser
// terminal widget shows "Connection error. Is the gateway running?" even
// though the gateway is up.
//
// This runs as `postinstall` and is a no-op if node-pty isn't installed
// or the spawn-helper files already have the execute bit set.

import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [
  "node_modules/node-pty/prebuilds",
  "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds",
];

let fixed = 0;
for (const root of roots) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const helper = join(root, entry.name, "spawn-helper");
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0o111) continue;
      chmodSync(helper, mode | 0o111);
      fixed++;
    } catch {
      // File may not exist on this platform prebuild (e.g. win32). Ignore.
    }
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] restored execute bits on ${fixed} spawn-helper binary(ies)`);
}
