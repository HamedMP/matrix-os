import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceFiles = [
  "scripts/openmausbot/prepare-host-package.sh",
  "scripts/openmausbot/apply-private-host.mjs",
  "scripts/openmausbot/apply-matrix-theme.mjs",
  "scripts/openmausbot/matrix-provider.ts",
  "scripts/openmausbot/matrix-drive-mcp.mjs",
  "scripts/openmausbot/runtime-pnpm-lock.yaml",
  "packages/brand/src/tokens.ts",
  "packages/ui/src/chat-agents/RecipeRabbit.tsx",
  "shell/public/system-app-icons/v2/bots.svg",
];

export async function buildOpenMausBotHostImage(source, archive, sha, run) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("OpenMausBot image requires the exact host build SHA");
  const image = "matrix-openmausbot-oss:matrix-" + sha;
  const context = await mkdtemp(join(tmpdir(), "matrix-openmausbot-builder-"));
  try {
    await copyFile(join(source, "scripts/openmausbot/Dockerfile"), join(context, "Dockerfile"));
    // Match source-relative imports and asset paths inside the isolated build.
    for (const file of sourceFiles) {
      const destination = join(context, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(source, file), destination);
    }
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
