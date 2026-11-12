/**
 * Matrix Core repo installer (spec 2691, layer 6). Installs each org's pinned
 * commit beside the user's own files, never inside `$MATRIX_HOME`:
 *
 *   <root>/<orgId>/releases/<commit>-<slug>/   the repo plus `.matrix-skills/`
 *   <root>/<orgId>/current  -> releases/<commit>-<slug>
 *   <root>/<orgId>/previous -> releases/<older commit>-<slug>   (rollback)
 *
 * A release is verified (size, sha256, archive rules) and fully built in a
 * staging directory, renamed into place, and only then made current with an
 * atomic symlink rename. A failed download, checksum, archive, or skill sync
 * leaves the previous commit current. Skills are linked as `org-<slug>-<name>`
 * by `sync-matrix-agent-skills.sh` in namespace mode, which never touches
 * personal skills. Hooks and scripts are installed but not activated.
 */
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CORE_REPO_MAX_SKILL_NAME_LENGTH,
  CORE_REPO_MAX_TARBALL_BYTES,
  CoreRepoPinSchema,
  CoreRepoPinsResponseSchema,
  coreRepoSkillNamespace,
  type CoreRepoPin,
} from "@matrix-os/contracts";
import { extractCoreRepoArchive, sha256Hex } from "./archive.js";
import { CoreRepoLockedError, acquireCoreRepoLock } from "./lock.js";

const execFileAsync = promisify(execFile);
const ORG_DIR = /^org_[A-Za-z0-9]{1,124}$/;
const SKILL_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const META_FILE = ".matrix-core.json";
const SKILLS_DIR = ".matrix-skills";
const STAGING_PREFIX = ".staging-";
const STAGING_TTL_MS = 60 * 60_000;
const MAX_SKILLS = 500;
const SKILL_SYNC_TIMEOUT_MS = 120_000;

export interface CoreRepoPinList {
  pins: CoreRepoPin[];
  /** True only when the platform confirmed membership; absent orgs may then be removed. */
  membershipVerified: boolean;
}

export interface CoreRepoTransport {
  listPins(): Promise<CoreRepoPinList>;
  downloadTarball(pin: CoreRepoPin): Promise<Uint8Array>;
}

export interface SkillSyncInput {
  source: string;
  namespace: string;
  ownedRoot: string;
  /** Agent destinations for this run (`MATRIX_SKILL_TARGETS`). */
  targets: readonly string[];
}

/** The script's agents when `MATRIX_SKILL_TARGETS` is unset. */
export const DEFAULT_SKILL_TARGETS: readonly string[] = ["matrix", "claude", "codex", "hermes"];
/** The agents `sync-matrix-agent-skills.sh` knows; the script rejects anything else in namespace mode. */
const KNOWN_SKILL_TARGETS = new Set(["matrix", "claude", "codex", "hermes", "agent"]);
const MAX_SKILL_TARGETS = 16;
const TARGETS_FILE = ".matrix-core-targets.json";
const TARGETS_TEMP_PREFIX = ".targets-";
/** Temporary links created by `pointAt` before they are renamed over `current`/`previous`. */
const POINTER_TEMP_PATTERN = /^\.(current|previous)-\d+-\d+$/;

/**
 * De-duplicated targets from a `MATRIX_SKILL_TARGETS`-style list. Unset means
 * the defaults; an explicitly empty list means no agents. Any unknown name
 * (including `Claude`) is an error, never silently dropped.
 */
export function parseSkillTargets(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_SKILL_TARGETS];
  const targets = value.split(",").map(target => target.trim()).filter(Boolean);
  if (targets.length > MAX_SKILL_TARGETS || targets.some(target => !KNOWN_SKILL_TARGETS.has(target))) throw new CoreRepoInstallError("invalid_targets");
  return [...new Set(targets)];
}
export type CoreRepoInstallStatus = "installed" | "current" | "removed" | "failed";
export interface CoreRepoInstallResult {
  orgId: string;
  status: CoreRepoInstallStatus;
  commit?: string;
  /** Skill directories that were not installed (invalid, duplicate, too long, or over the cap). */
  rejectedSkills?: string[];
}
const MAX_REPORTED_REJECTIONS = 50;

export class CoreRepoInstallError extends Error {
  constructor(readonly code: "locked" | "pins_unavailable" | "invalid_targets") {
    super(code);
    this.name = "CoreRepoInstallError";
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new Error("CoreRepoDownloadRejected");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("CoreRepoDownloadRejected");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** Platform transport: a fixed origin, no redirects, deadlines, bounded bodies. */
export function createCoreRepoHttpTransport(options: { baseUrl: string; headers: Record<string, string>; fetchImpl?: typeof fetch }): CoreRepoTransport {
  const origin = new URL(options.baseUrl).origin;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async listPins() {
      const response = await fetchImpl(`${origin}/internal/core-repo/pins`, {
        headers: { accept: "application/json", ...options.headers }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CoreRepoInstallError("pins_unavailable");
      }
      const text = new TextDecoder().decode(await readBounded(response, 256 * 1024));
      const parsed = CoreRepoPinsResponseSchema.parse(JSON.parse(text));
      return { pins: parsed.pins, membershipVerified: parsed.membership === "verified" };
    },
    async downloadTarball(pin) {
      const response = await fetchImpl(`${origin}/internal/core-repo/${pin.orgId}/${pin.commit}.tar.gz`, {
        headers: options.headers, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("CoreRepoDownloadRejected");
      }
      return readBounded(response, Math.min(pin.bytes, CORE_REPO_MAX_TARBALL_BYTES));
    },
  };
}

/** Runs the shared skills sync script in namespace mode. */
export function createScriptSkillSync(script: string, env: NodeJS.ProcessEnv = process.env) {
  return async (input: SkillSyncInput): Promise<void> => {
    await execFileAsync("bash", [script], {
      env: { ...env, MATRIX_SKILLS_SOURCE: input.source, MATRIX_SKILL_NAMESPACE: input.namespace, MATRIX_SKILL_OWNED_ROOT: input.ownedRoot,
        MATRIX_SKILL_TARGETS: input.targets.join(",") },
      timeout: SKILL_SYNC_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    });
  };
}

async function currentMeta(orgRoot: string): Promise<{ commit: string; slug: string; target: string } | null> {
  try {
    const target = await readlink(join(orgRoot, "current"));
    const meta = JSON.parse(await readFile(join(orgRoot, target, META_FILE), "utf8")) as { commit?: unknown; slug?: unknown };
    return typeof meta.commit === "string" && typeof meta.slug === "string" ? { commit: meta.commit, slug: meta.slug, target } : null;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EINVAL" && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/** Atomic: a new link is written beside `name`, then renamed over it. */
async function pointAt(orgRoot: string, name: "current" | "previous", target: string): Promise<void> {
  const temporary = join(orgRoot, `.${name}-${process.pid}-${Date.now()}`);
  await symlink(target, temporary);
  try {
    await rename(temporary, join(orgRoot, name));
  } catch (error: unknown) {
    // Never leave the temporary link behind; a crash here is covered by sweepStaging.
    await rm(temporary, { force: true }).catch((cleanupError: unknown) => {
      console.warn(`[core-repo] could not remove temporary link: ${cleanupError instanceof Error ? cleanupError.name : "unknown"}`);
    });
    throw error;
  }
}

function namespacedSkill(text: string, name: string): string {
  if (/^---\r?\n/.test(text)) {
    const end = text.indexOf("\n---", 3);
    const head = end === -1 ? "" : text.slice(0, end);
    const replaced = /^name:.*$/m.test(head) ? head.replace(/^name:.*$/m, `name: ${name}`) : `${head}\nname: ${name}`;
    if (end !== -1) return replaced + text.slice(end);
  }
  return `---\nname: ${name}\n---\n\n${text}`;
}

/**
 * `skills/<name>` and `plugins/<group>/skills/<name>` become
 * `.matrix-skills/org-<slug>-<name>`. Returns the skill directories it did not
 * install, so the caller can report them.
 */
async function buildSkills(release: string, files: readonly string[], namespace: string): Promise<string[]> {
  const out = join(release, SKILLS_DIR);
  await mkdir(out);
  const seen = new Set<string>();
  const rejected: string[] = [];
  const reject = (raw: string) => {
    if (rejected.length < MAX_REPORTED_REJECTIONS) rejected.push(raw.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 64));
  };
  for (const path of files) {
    const match = /^(?:skills|plugins\/[^/]+\/skills)\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!match) continue;
    const base = match[1]!.toLowerCase();
    const name = `${namespace}${base}`;
    if (!SKILL_DIR.test(base) || name.length > CORE_REPO_MAX_SKILL_NAME_LENGTH || seen.has(base) || seen.size >= MAX_SKILLS) {
      reject(match[1]!);
      continue;
    }
    seen.add(base);
    const sourceDir = join(release, path.slice(0, -"/SKILL.md".length));
    const target = join(out, name);
    await mkdir(target);
    for (const file of files) {
      const prefix = path.slice(0, -"SKILL.md".length);
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      await mkdir(join(target, relative, ".."), { recursive: true });
      const content = await readFile(join(sourceDir, relative));
      // Keep a helper's executable bit; never carry setuid, setgid, sticky, or group/world write.
      const mode = (await stat(join(sourceDir, relative))).mode & 0o111 ? 0o755 : 0o644;
      const destination = join(target, relative);
      await writeFile(destination, relative === "SKILL.md" ? namespacedSkill(content.toString("utf8"), name) : content, { flag: "wx", mode });
      await chmod(destination, mode);
    }
  }
  return rejected;
}

async function sweepStaging(orgRoot: string, now: number): Promise<void> {
  for (const entry of await readdir(orgRoot)) {
    const staging = entry.startsWith(STAGING_PREFIX);
    const path = join(orgRoot, entry);
    if (POINTER_TEMP_PATTERN.test(entry)) {
      // Abandoned `pointAt` links: only symlinks, only stale ones; the live `current`/`previous` never match.
      const link = await lstat(path);
      if (link.isSymbolicLink() && now - link.mtimeMs > STAGING_TTL_MS) await rm(path, { force: true });
      continue;
    }
    if (!staging && !entry.startsWith(TARGETS_TEMP_PREFIX)) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink() || now - info.mtimeMs <= STAGING_TTL_MS) continue;
    // Staging leftovers are directories; targets temp files are regular files. Nothing else is touched.
    if (staging ? info.isDirectory() : info.isFile()) await rm(path, { recursive: true, force: true });
  }
}

async function pruneReleases(orgRoot: string, keep: readonly string[]): Promise<void> {
  const releases = join(orgRoot, "releases");
  for (const entry of await readdir(releases)) {
    if (keep.includes(`releases/${entry}`)) continue;
    const info = await lstat(join(releases, entry));
    if (info.isDirectory() && !info.isSymbolicLink()) await rm(join(releases, entry), { recursive: true, force: true });
  }
}

/** Every agent this org was ever linked into on this machine (a union across installs). */
async function recordedTargets(orgRoot: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(join(orgRoot, TARGETS_FILE), "utf8")) as unknown;
    return Array.isArray(value) ? value.filter((target): target is string => typeof target === "string" && KNOWN_SKILL_TARGETS.has(target)).slice(0, MAX_SKILL_TARGETS) : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

function currentTargets(options: InstallOptions): string[] {
  return options.targets === undefined ? [...DEFAULT_SKILL_TARGETS] : parseSkillTargets(options.targets.join(","));
}

/** Atomic replace; the temp file is removed if the write or rename fails (stale ones are swept too). */
async function writeTargets(orgRoot: string, targets: readonly string[]): Promise<void> {
  const temporary = join(orgRoot, `${TARGETS_TEMP_PREFIX}${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, JSON.stringify([...new Set(targets)].slice(0, MAX_SKILL_TARGETS)), { flag: "wx" });
    await rename(temporary, join(orgRoot, TARGETS_FILE));
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Links the current release's skills into today's agents. First it unlinks
 * this namespace from recorded agents that are no longer selected (their
 * links would otherwise outlive the releases they point at); a dropped agent
 * leaves the record only after that unlink succeeds. The new targets are
 * recorded before linking, so a crash mid-sync still knows where to clean up.
 */
async function linkNamespace(options: InstallOptions, orgRoot: string, namespace: string): Promise<void> {
  const targets = currentTargets(options);
  let recorded = await recordedTargets(orgRoot);
  const dropped = recorded.filter(target => !targets.includes(target));
  if (dropped.length > 0) {
    const empty = await mkdtemp(join(orgRoot, STAGING_PREFIX));
    try {
      await options.runSkillSync({ source: empty, namespace, ownedRoot: orgRoot, targets: dropped });
      recorded = recorded.filter(target => targets.includes(target));
    } catch (error: unknown) {
      console.warn("[core-repo] dropped-agent unlink failed; retried next run", error instanceof Error ? error.name : "UnknownError");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }
  await writeTargets(orgRoot, [...recorded, ...targets]);
  await options.runSkillSync({ source: join(orgRoot, "current", SKILLS_DIR), namespace, ownedRoot: orgRoot, targets });
}

/** Unlinks every skill in `namespace` that points into this org's root, in every agent it was ever linked into. */
async function unlinkNamespace(options: InstallOptions, orgRoot: string, namespace: string): Promise<void> {
  const targets = [...new Set([...(await recordedTargets(orgRoot)), ...currentTargets(options)])];
  const empty = await mkdtemp(join(orgRoot, STAGING_PREFIX));
  try {
    await options.runSkillSync({ source: empty, namespace, ownedRoot: orgRoot, targets });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

function warnStep(step: string, orgId: string, error: unknown): void {
  console.warn(`[core-repo] ${step} failed`, { orgId, error: error instanceof Error ? error.name : "UnknownError" });
}

async function installPin(options: InstallOptions, pin: CoreRepoPin): Promise<CoreRepoInstallResult> {
  const orgRoot = join(options.root, pin.orgId);
  await mkdir(join(orgRoot, "releases"), { recursive: true });
  await sweepStaging(orgRoot, Date.now());
  const before = await currentMeta(orgRoot);
  // The slug is part of what is installed: a renamed org must move namespaces even at the same commit.
  if (before?.commit === pin.commit && before.slug === pin.slug) {
    // Same release, but agents (targets) may have been added since: relink it. The script is idempotent.
    try {
      await linkNamespace(options, orgRoot, coreRepoSkillNamespace(pin.slug));
    } catch (error: unknown) {
      warnStep("skill relink", pin.orgId, error);
      return { orgId: pin.orgId, status: "failed", commit: pin.commit };
    }
    return { orgId: pin.orgId, status: "current", commit: pin.commit };
  }
  const namespace = coreRepoSkillNamespace(pin.slug);
  const previousNamespace = before && before.slug !== pin.slug ? coreRepoSkillNamespace(before.slug) : undefined;
  const staging = await mkdtemp(join(orgRoot, STAGING_PREFIX));
  const releaseName = `releases/${pin.commit}-${pin.slug}`;
  let rejectedSkills: string[];
  try {
    const bytes = await options.transport.downloadTarball(pin);
    if (bytes.byteLength !== pin.bytes || sha256Hex(bytes) !== pin.sha256) throw new Error("CoreRepoChecksumMismatch");
    const release = join(staging, "release");
    await mkdir(release);
    const files = await extractCoreRepoArchive(bytes, release);
    rejectedSkills = await buildSkills(release, files, namespace);
    await writeFile(join(release, META_FILE), JSON.stringify({ orgId: pin.orgId, slug: pin.slug, commit: pin.commit, sha256: pin.sha256 }), { flag: "wx" });
    await rm(join(orgRoot, releaseName), { recursive: true, force: true });
    await rename(release, join(orgRoot, releaseName));
  } catch (error: unknown) {
    console.warn("[core-repo] install rejected; previous commit kept", { orgId: pin.orgId, error: error instanceof Error ? error.message.slice(0, 64) : "UnknownError" });
    return { orgId: pin.orgId, status: "failed" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await pointAt(orgRoot, "current", releaseName);
  try {
    if (previousNamespace) await unlinkNamespace(options, orgRoot, previousNamespace);
    await linkNamespace(options, orgRoot, namespace);
  } catch (error: unknown) {
    warnStep("skill sync; rolling back", pin.orgId, error);
    if (before) {
      await pointAt(orgRoot, "current", before.target);
      if (previousNamespace) await unlinkNamespace(options, orgRoot, namespace).catch((retry: unknown) => warnStep("new namespace unlink", pin.orgId, retry));
      await linkNamespace(options, orgRoot, coreRepoSkillNamespace(before.slug))
        .catch((retry: unknown) => warnStep("rollback skill sync", pin.orgId, retry));
    } else {
      // No earlier release to return to: unlink whatever this attempt linked before dropping `current`.
      await unlinkNamespace(options, orgRoot, namespace).catch((retry: unknown) => warnStep("failed-install unlink", pin.orgId, retry));
      await rm(join(orgRoot, "current"), { force: true });
    }
    return { orgId: pin.orgId, status: "failed" };
  }
  if (before) await pointAt(orgRoot, "previous", before.target);
  await pruneReleases(orgRoot, before ? [releaseName, before.target] : [releaseName]);
  return { orgId: pin.orgId, status: "installed", commit: pin.commit, ...(rejectedSkills.length > 0 ? { rejectedSkills } : {}) };
}

/** Membership ended or the org stopped publishing: unlink its skills, then remove its files. */
async function removeOrg(options: InstallOptions, orgId: string): Promise<CoreRepoInstallResult> {
  const orgRoot = join(options.root, orgId);
  const meta = await currentMeta(orgRoot);
  if (meta) {
    try {
      await unlinkNamespace(options, orgRoot, coreRepoSkillNamespace(meta.slug));
    } catch (error: unknown) {
      warnStep("skill removal; files kept", orgId, error);
      return { orgId, status: "failed" };
    }
  }
  await rm(orgRoot, { recursive: true, force: true });
  return { orgId, status: "removed" };
}

export interface InstallOptions {
  transport: CoreRepoTransport;
  /** Outside `$MATRIX_HOME`; one directory per org. */
  root: string;
  runSkillSync(input: SkillSyncInput): Promise<void>;
  /** Agents to link into this run; defaults to the script's own default set. */
  targets?: readonly string[];
  /** Test hook; production renews the lock every minute. */
  lockHeartbeatMs?: number;
}

export async function installCoreRepo(options: InstallOptions): Promise<CoreRepoInstallResult[]> {
  // Reject an invalid agent selection before any file is touched.
  currentTargets(options);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof acquireCoreRepoLock>>;
  try { lock = await acquireCoreRepoLock(join(options.root, ".lock"), { heartbeatMs: options.lockHeartbeatMs }); }
  catch (error: unknown) {
    if (error instanceof CoreRepoLockedError) throw new CoreRepoInstallError("locked");
    throw error;
  }
  try {
    let pins: CoreRepoPin[];
    let membershipVerified: boolean;
    try {
      const listed = await options.transport.listPins();
      pins = listed.pins.map(pin => CoreRepoPinSchema.parse(pin));
      membershipVerified = listed.membershipVerified === true;
    }
    catch (error: unknown) {
      if (error instanceof CoreRepoInstallError) throw error;
      console.warn("[core-repo] pins unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new CoreRepoInstallError("pins_unavailable");
    }
    const results: CoreRepoInstallResult[] = [];
    for (const pin of pins) results.push(await installPin(options, pin));
    // Removal needs confirmed membership loss; an unverified list only installs.
    if (!membershipVerified) return results;
    const pinned = new Set(pins.map(pin => pin.orgId));
    for (const entry of await readdir(options.root)) {
      if (!ORG_DIR.test(entry) || pinned.has(entry)) continue;
      const info = await lstat(join(options.root, entry));
      if (info.isDirectory() && !info.isSymbolicLink()) results.push(await removeOrg(options, entry));
    }
    return results;
  } finally {
    await lock.release();
  }
}

