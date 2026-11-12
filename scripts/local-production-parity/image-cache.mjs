import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { baseImagePath, baseImageChecksumPath, ubuntuImageUrl } from "./config.mjs";
import { runCommand } from "./commands.mjs";

async function digest(path, signal) {
  const hash = createHash("sha256");
  const deadline = AbortSignal.timeout(5 * 60_000);
  for await (const chunk of createReadStream(path, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareBaseImage(signal, options = {}) {
  const imagePath = options.imagePath ?? baseImagePath;
  const checksumPath = options.checksumPath ?? baseImageChecksumPath;
  const imageUrl = options.imageUrl ?? ubuntuImageUrl;
  const execute = options.execute ?? runCommand;
  // Two reserved staging files bound leftovers after a killed launcher. The
  // checkout lock excludes concurrent writers; unlink never follows symlinks.
  const stagedImage = `${imagePath}.download`;
  const stagedChecksum = `${checksumPath}.download`;
  for (const path of [stagedImage, stagedChecksum]) rmSync(path, { force: true });
  signal?.throwIfAborted();
  if (existsSync(imagePath) && existsSync(checksumPath)) {
    const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
    if (/^[a-f0-9]{64}$/i.test(expected) && await digest(imagePath, signal) === expected.toLowerCase()) return;
  }
  mkdirSync(dirname(imagePath), { recursive: true });
  try {
    for (const path of [stagedImage, stagedChecksum]) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    await execute("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "10", "--max-time", "1800", imageUrl, "-o", stagedImage], { signal, timeoutMs: 30 * 60_000 });
    await execute("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "10", "--max-time", "120", `${new URL(".", imageUrl)}SHA256SUMS`, "-o", stagedChecksum], { signal, timeoutMs: 5 * 60_000 });
    if (statSync(stagedChecksum).size > 1024 * 1024) throw new Error("Ubuntu checksum manifest is too large");
    const imageName = new URL(imageUrl).pathname.split("/").at(-1);
    const entry = readFileSync(stagedChecksum, "utf8").split("\n").find((line) => line.trim().endsWith(`*${imageName}`));
    const expected = entry?.trim().split(/\s+/)[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || await digest(stagedImage, signal) !== expected.toLowerCase()) {
      throw new Error("Ubuntu base image checksum verification failed");
    }
    writeFileSync(stagedChecksum, `${expected}  ${imagePath}\n`);
    signal?.throwIfAborted();
    renameSync(stagedImage, imagePath);
    renameSync(stagedChecksum, checksumPath);
  } finally {
    for (const path of [stagedImage, stagedChecksum]) rmSync(path, { force: true });
  }
}
