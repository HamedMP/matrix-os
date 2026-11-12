/**
 * Matrix Core repo installer (spec 2691, layer 6). Installs each org's pinned
 * commit beside the user's own files, never inside `$MATRIX_HOME`:
 *
 *   <root>/<orgId>/releases/<commit>/   the repo plus `.matrix-skills/`
 *   <root>/<orgId>/current  -> releases/<commit>
 *   <root>/<orgId>/previous -> releases/<older commit>   (rollback)
 *
 * A release is verified (size, sha256, archive rules) and fully built in a
 * staging directory, renamed into place, and only then made current with an
 * atomic symlink rename. A failed download, checksum, archive, or skill sync
 * leaves the previous commit current. Skills are linked as `org-<slug>-<name>`
 * by `sync-matrix-agent-skills.sh` in namespace mode, which never touches
 * personal skills. Hooks and scripts are installed but not activated.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CORE_REPO_MAX_TARBALL_BYTES,
  CoreRepoPinSchema,
  CoreRepoPinsResponseSchema,
  coreRepoSkillNamespace,
  type CoreRepoPin,
} from "@matrix-os/contracts";
import { extractCoreRepoArchive, sha256Hex } from "./archive.js";

const execFileAsync = promisify(execFile);
const ORG_DIR = /^org_[A-Za-z0-9]{1,124}$/;
const SKILL_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const META_FILE = ".matrix-core.json";
const SKILLS_DIR = ".matrix-skills";
const STAGING_PREFIX = ".staging-";
const STAGING_TTL_MS = 60 * 60_000;
const LOCK_TTL_MS = 10 * 60_000;
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

export interface SkillSyncInput { source: string; namespace: string; ownedRoot: string }
export type CoreRepoInstallStatus = "installed" | "current" | "removed" | "failed";
export interface CoreRepoInstallResult { orgId: string; status: CoreRepoInstallStatus; commit?: string }

export class CoreRepoInstallError extends Error {
  constructor(readonly code: "locked" | "pins_unavailable") {
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
        MATRIX_SKILL_TARGETS: env.MATRIX_SKILL_TARGETS ?? "matrix,claude,codex,hermes" },
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
  await rename(temporary, join(orgRoot, name));
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

/** `skills/<name>` and `plugins/<group>/skills/<name>` become `.matrix-skills/org-<slug>-<name>`. */
async function buildSkills(release: string, files: readonly string[], namespace: string): Promise<void> {
  const out = join(release, SKILLS_DIR);
  await mkdir(out);
  const seen = new Set<string>();
  for (const path of files) {
    const match = /^(?:skills|plugins\/[^/]+\/skills)\/([^/]+)\/SKILL\.md$/.exec(path);
    const base = match?.[1]?.toLowerCase();
    if (!base || !SKILL_DIR.test(base) || seen.has(base) || seen.size >= MAX_SKILLS) continue;
    seen.add(base);
    const name = `${namespace}${base}`;
    const sourceDir = join(release, path.slice(0, -"/SKILL.md".length));
    const target = join(out, name);
    await mkdir(target);
    for (const file of files) {
      const prefix = path.slice(0, -"SKILL.md".length);
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      await mkdir(join(target, relative, ".."), { recursive: true });
      const content = await readFile(join(sourceDir, relative));
      await writeFile(join(target, relative), relative === "SKILL.md" ? namespacedSkill(content.toString("utf8"), name) : content, { flag: "wx" });
    }
  }
}

async function sweepStaging(orgRoot: string, now: number): Promise<void> {
  for (const entry of await readdir(orgRoot)) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const path = join(orgRoot, entry);
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink() && now - info.mtimeMs > STAGING_TTL_MS) await rm(path, { recursive: true, force: true });
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

async function installPin(options: InstallOptions, pin: CoreRepoPin): Promise<CoreRepoInstallResult> {
  const orgRoot = join(options.root, pin.orgId);
  await mkdir(join(orgRoot, "releases"), { recursive: true });
  await sweepStaging(orgRoot, Date.now());
  const before = await currentMeta(orgRoot);
  if (before?.commit === pin.commit) return { orgId: pin.orgId, status: "current", commit: pin.commit };
  const namespace = coreRepoSkillNamespace(pin.slug);
  const staging = await mkdtemp(join(orgRoot, STAGING_PREFIX));
  const releaseName = `releases/${pin.commit}`;
  try {
    const bytes = await options.transport.downloadTarball(pin);
    if (bytes.byteLength !== pin.bytes || sha256Hex(bytes) !== pin.sha256) throw new Error("CoreRepoChecksumMismatch");
    const release = join(staging, "release");
    await mkdir(release);
    const files = await extractCoreRepoArchive(bytes, release);
    await buildSkills(release, files, namespace);
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
    await options.runSkillSync({ source: join(orgRoot, "current", SKILLS_DIR), namespace, ownedRoot: orgRoot });
  } catch (error: unknown) {
    console.warn("[core-repo] skill sync failed; rolling back", { orgId: pin.orgId, error: error instanceof Error ? error.name : "UnknownError" });
    if (before) {
      await pointAt(orgRoot, "current", before.target);
      await options.runSkillSync({ source: join(orgRoot, "current", SKILLS_DIR), namespace, ownedRoot: orgRoot }).catch((retry: unknown) => {
        console.warn("[core-repo] rollback skill sync failed", retry instanceof Error ? retry.name : "UnknownError");
      });
    } else {
      await rm(join(orgRoot, "current"), { force: true });
    }
    return { orgId: pin.orgId, status: "failed" };
  }
  if (before) await pointAt(orgRoot, "previous", before.target);
  await pruneReleases(orgRoot, before ? [releaseName, before.target] : [releaseName]);
  return { orgId: pin.orgId, status: "installed", commit: pin.commit };
}

/** Membership ended or the org stopped publishing: unlink its skills, then remove its files. */
async function removeOrg(options: InstallOptions, orgId: string): Promise<CoreRepoInstallResult> {
  const orgRoot = join(options.root, orgId);
  const meta = await currentMeta(orgRoot);
  if (meta) {
    const empty = await mkdtemp(join(orgRoot, STAGING_PREFIX));
    try {
      await options.runSkillSync({ source: empty, namespace: coreRepoSkillNamespace(meta.slug), ownedRoot: orgRoot });
    } catch (error: unknown) {
      console.warn("[core-repo] skill removal failed; files kept", { orgId, error: error instanceof Error ? error.name : "UnknownError" });
      return { orgId, status: "failed" };
    } finally {
      await rm(empty, { recursive: true, force: true });
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
}

export async function installCoreRepo(options: InstallOptions): Promise<CoreRepoInstallResult[]> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const lock = join(options.root, ".lock");
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs > LOCK_TTL_MS) await rm(lock, { force: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try { await writeFile(lock, String(process.pid), { flag: "wx" }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CoreRepoInstallError("locked");
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
    await rm(lock, { force: true });
  }
}

