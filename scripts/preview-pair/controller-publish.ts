import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewPairPreparedSchema, PreviewPairControlOriginSchema, type PreviewPairControllerReceipt } from "../../packages/contracts/src/preview-pair-control.js";
import { downloadPreviewPairArtifact } from "./artifact-download.js";
import { previewRunArtifact, type previewControllerGitHub } from "./controller-artifacts.js";
import { readPreviewPairHostBundle } from "./publication-artifacts.js";
import { runPreviewTool } from "./reviewed-process.js";

const hostFiles = new Set(["release.json", "manifest.json", "incremental-manifest.json", "matrix-host-bundle.tar.gz", "matrix-host-bundle.tar.gz.sha256"]); // Five static entries.
const required = (env: NodeJS.ProcessEnv, name: string) => { const value = env[name]; if (!value || value.length > 16_384) throw new Error("Preview publication setup is unavailable"); return value; };
export async function publishPreviewPairBuild(options: { github: ReturnType<typeof previewControllerGitHub>; token: string;
  request: PreviewPairControllerReceipt; prepared: unknown; env: NodeJS.ProcessEnv }) {
  const prepared = PreviewPairPreparedSchema.parse(options.prepared), { request, env } = options;
  const controlOrigin = PreviewPairControlOriginSchema.parse(env.PAIR_CONTROL_ORIGIN);
  if (prepared.kind !== "request" || prepared.pairId !== request.pairId || prepared.generation !== request.generation) throw new Error("Preview build is unavailable");
  const endpoint = new URL(required(env, "PAIR_BUNDLES_ENDPOINT"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port
    || endpoint.pathname !== "/" || !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)) throw new Error("Preview storage is unavailable");
  const bucket = required(env, "PAIR_BUNDLES_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Preview storage is unavailable");
  const registryToken = required(env, "PAIR_REGISTRY_TOKEN");
  const bundlesKey = required(env, "PAIR_BUNDLES_ACCESS_KEY_ID"), bundlesSecret = required(env, "PAIR_BUNDLES_SECRET_ACCESS_KEY");
  const registrationSecret = required(env, "PAIR_RELEASE_REGISTRATION_SECRET");
  const hostIdentity = await previewRunArtifact(options.github, request.runId, `preview-pair-host-${request.runId}`);
  const imageIdentity = await previewRunArtifact(options.github, request.runId, `preview-pair-image-${request.runId}`);
  const host = await downloadPreviewPairArtifact({ token: options.token, expected: hostIdentity,
    allowFile: name => hostFiles.has(name) || /^objects\/sha256\/[a-f0-9]{64}$/.test(name) });
  try {
    const hostBundle = await readPreviewPairHostBundle(host.directory, request);
    const image = await downloadPreviewPairArtifact({ token: options.token, expected: imageIdentity, allowFile: name => name === "image.tar" });
    try {
      const dockerConfig = await mkdtemp(join(tmpdir(), "matrix-preview-docker-")), owned = await lstat(dockerConfig);
      try {
        const imageRepository = prepared.buildContext.imageRepository, registry = imageRepository.split("/")[0]!;
        const target = `${imageRepository}:cp-${request.pairId}-g${request.generation}-${request.sourceSha}`;
        const dockerEnv = { PATH: env.PATH, HOME: env.HOME, DOCKER_CONFIG: dockerConfig };
        await runPreviewTool("docker", ["load", "--input", join(image.directory, "image.tar")], dockerEnv);
        await runPreviewTool("docker", ["tag", `matrix-preview-pair:${request.sourceSha}`, target], dockerEnv);
        await runPreviewTool("docker", ["login", "--username", "oauth2accesstoken", "--password-stdin", registry], dockerEnv, registryToken);
        await runPreviewTool("docker", ["push", target], dockerEnv);
        const raw = JSON.parse(await runPreviewTool("docker", ["image", "inspect", target, "--format", "{{json .RepoDigests}}"], dockerEnv));
        if (!Array.isArray(raw) || raw.length > 16) throw new Error("Preview image is unavailable");
        const digests = raw.filter(item => typeof item === "string" && item.startsWith(`${imageRepository}@sha256:`)
          && /^[a-f0-9]{64}$/.test(item.slice(`${imageRepository}@sha256:`.length)));
        if (digests.length !== 1) throw new Error("Preview image is unavailable");
        // Reviewed publisher only; explicit channel=none and no deploy invocation.
        await runPreviewTool("node", ["scripts/publish-release-r2.mjs", hostBundle.version, "--channel", "none",
          "--source-pr", String(request.pr), "--include-incremental-objects"], { PATH: env.PATH, HOME: env.HOME,
          HOST_BUNDLE_DIST_DIR: host.directory, R2_ENDPOINT: endpoint.origin, R2_BUCKET: bucket,
          AWS_ACCESS_KEY_ID: bundlesKey, AWS_SECRET_ACCESS_KEY: bundlesSecret,
          PLATFORM_PUBLIC_URL: controlOrigin, PLATFORM_SECRET: registrationSecret });
        return { hostBundle, imageSha256: digests[0].slice(`${imageRepository}@sha256:`.length) as string };
      } finally {
        const current = await lstat(dockerConfig);
        if (current.isDirectory() && current.ino === owned.ino && current.dev === owned.dev) await rm(dockerConfig, { recursive: true });
        else console.warn("[preview-pair] Docker credential directory ownership changed");
      }
    } finally { await image.dispose(); }
  } finally { await host.dispose(); }
}
