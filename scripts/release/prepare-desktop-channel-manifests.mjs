import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHANNELS = new Set(["stable", "beta", "canary", "dev"]);
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const MAX_RELEASE_NOTES_LENGTH = 32 * 1024;

const [sourceDirectory, outputDirectory, owner, repo, immutableTag, channel, notesPath] =
  process.argv.slice(2);

if (
  !sourceDirectory ||
  !outputDirectory ||
  !owner ||
  !repo ||
  !immutableTag ||
  !channel ||
  !notesPath
) {
  throw new Error(
    "usage: node scripts/release/prepare-desktop-channel-manifests.mjs " +
      "<source-directory> <output-directory> <owner> <repo> <immutable-tag> <channel> <release-notes>",
  );
}

if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo)) {
  throw new Error("owner and repo must be safe GitHub repository identifiers");
}
if (!SAFE_TAG.test(immutableTag)) {
  throw new Error("immutable tag must be a safe release tag");
}
if (!CHANNELS.has(channel)) {
  throw new Error(`unsupported desktop update channel: ${channel}`);
}

const platformManifestNames = [
  channel === "stable" ? "latest-mac.yml" : `${channel}-mac.yml`,
  channel === "stable" ? "latest-linux.yml" : `${channel}-linux.yml`,
];
const releaseNotes = (await readFile(notesPath, "utf8")).trim().slice(0, MAX_RELEASE_NOTES_LENGTH);
if (!releaseNotes) {
  throw new Error("release notes must not be empty");
}

const releaseBase =
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
  `/releases/download/${encodeURIComponent(immutableTag)}/`;

function immutableArtifactUrl(rawArtifactName) {
  const artifactName = rawArtifactName.trim().replace(/^['"]|['"]$/g, "");
  if (!SAFE_ARTIFACT.test(artifactName)) {
    throw new Error(`unsafe desktop artifact name: ${rawArtifactName}`);
  }
  return `${releaseBase}${encodeURIComponent(artifactName)}`;
}

function prepareManifest(source) {
  const withoutExistingNotes = source.replace(
    /^releaseNotes:\s*\|[-+]?\n(?:^[ \t].*(?:\n|$))*/m,
    "",
  );
  const withImmutableUrls = withoutExistingNotes.replace(
    /^(\s*(?:-\s+url|path):\s*)([^\n]+)$/gm,
    (_match, prefix, artifactName) => `${prefix}${immutableArtifactUrl(artifactName)}`,
  );
  const notesBlock = releaseNotes
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${withImmutableUrls.trimEnd()}\nreleaseNotes: |-\n${notesBlock}\n`;
}

await mkdir(outputDirectory, { recursive: true });
for (const manifestName of platformManifestNames) {
  const source = await readFile(join(sourceDirectory, manifestName), "utf8");
  await writeFile(join(outputDirectory, manifestName), prepareManifest(source), "utf8");
}

console.log(`prepared ${platformManifestNames.join(", ")} for desktop-${channel}`);
