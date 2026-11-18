import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceFiles = [
  "Dockerfile", "prepare-host-package.sh", "apply-private-host.mjs", "apply-matrix-theme.mjs",
  "matrix-provider.ts", "matrix-drive-mcp.mjs", "runtime-pnpm-lock.yaml",
];

export async function buildOpenMausBotHostImage(source, archive, sha, run) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("OpenMausBot image requires the exact host build SHA");
  const image = "matrix-openmausbot-oss:matrix-" + sha;
  const context = await mkdtemp(join(tmpdir(), "matrix-openmausbot-builder-"));
  try {
    for (const file of sourceFiles) {
      await copyFile(join(source, "scripts/openmausbot", file), join(context, file));
    }
    await copyFile(join(source, "shell/public/system-app-icons/v2/bots.svg"), join(context, "bots.svg"));
    await run("docker", [
      "build", "--platform", "linux/amd64", "--tag", image,
      "--label", "org.matrix-os.openmausbot.bundle-sha=" + sha, context,
    ]);
    // Save the tag. BuildKit's image ID can be an index digest that the host's
    // Docker image store does not retain after importing the archive.
    await run("docker", ["save", "--output", archive, image]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

function runLocalBuild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", signal: AbortSignal.timeout(30 * 60_000) });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`OpenMausBot image build failed (${code})`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildOpenMausBotHostImage(process.argv[2], process.argv[3], process.argv[4], runLocalBuild);
}
