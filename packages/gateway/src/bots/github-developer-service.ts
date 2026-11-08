/** Host-only Git/gh. The worker supplies typed actions, never credentials or argv. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { GithubDeveloperActionSchema, GithubDeveloperPathSchema, type GithubDeveloperAction } from "@matrix-os/contracts";
import { githubOwnerEnvironment } from "../github-owner-environment.js";
import { BotBrokerActionError } from "./broker-actions.js";
import { createGithubDeveloperStaging } from "./github-developer-staging.js";

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const DEVELOPMENT_BRANCH = /^matrix\/[A-Za-z0-9][A-Za-z0-9_/-]{0,111}$/;
const SAFE_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch)|branch\.[a-z0-9_./-]+\.(?:remote|merge))$/i;
type Result = Record<string, unknown>;
type RunOptions = { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; maxBuffer: number; killSignal: NodeJS.Signals };
export type GithubDeveloperCommand = (command: string, args: string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }>;
export interface GithubDeveloperPlan { account: string; repository?: string; branch?: string; head?: string; filesFingerprint?: string; author?: { name: string; email: string }; }

function refuse(): never { throw new BotBrokerActionError("invalid_arguments"); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Walk every segment, never follow a workspace or repository symlink. */
async function pathWithin(root: string, relative: string, parentOnly = false): Promise<string> {
  const parsed = GithubDeveloperPathSchema.safeParse(relative);
  if (!parsed.success) refuse();
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse();
  const parts = parsed.data.split("/");
  let path = await realpath(root);
  for (const part of parentOnly ? parts.slice(0, -1) : parts) {
    path = join(path, part);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) refuse();
  }
  return parentOnly ? join(path, parts.at(-1)!) : path;
}

export function createGithubDeveloperService(deps: {
  homePath: string;
  status(signal: AbortSignal): Promise<{ ready: boolean; user: string | null }>;
  run?: GithubDeveloperCommand;
}) {
  const runCommand: GithubDeveloperCommand = deps.run ?? ((command, args, options) => exec(command, args, options));
  const ownerEnv = { ...githubOwnerEnvironment(deps.homePath), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  // Explicit remote argv bypasses repository rewrites. Global Git config is only
  // read to resolve identity; commands cannot execute owner/global filter hooks.
  const gitEnv = { ...ownerEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o ${quote(`UserKnownHostsFile=${join(deps.homePath, ".ssh", "matrix-github-known-hosts")}`)} -o ConnectTimeout=10 -o ConnectionAttempts=1` };
  const stagingFiles = createGithubDeveloperStaging(deps.homePath);
  const locks = new Set<string>(); // <=64; released in finally, no persistent queue.
  async function run(cwd: string, command: string, args: string[], signal: AbortSignal, env: NodeJS.ProcessEnv = command === "git" ? gitEnv : ownerEnv) {
    if (signal.aborted) throw new BotBrokerActionError("stale_generation");
    return runCommand(command, args, { cwd, env, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), maxBuffer: 64 * 1024, killSignal: "SIGKILL" });
  }
  async function git(cwd: string, args: string[], signal: AbortSignal, identity?: {name: string;email: string}, index?: string) {
    return run(cwd, "git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null",
      "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "credential.helper=",
      "-c", "credential.helper=!gh auth git-credential", ...args], signal, identity ? {
        ...gitEnv, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
        ...(index ? { GIT_INDEX_FILE: index } : {}),
      } : index ? { ...gitEnv, GIT_INDEX_FILE: index } : gitEnv);
  }
  async function repository(root: string, path: string, signal: AbortSignal) {
    const cwd = await pathWithin(root, path);
    for (const relative of [".git", ".git/config", ".git/HEAD"]) {
      const info = await lstat(join(cwd, relative));
      if (info.isSymbolicLink() || (relative === ".git" ? !info.isDirectory() : !info.isFile())) refuse();
    }
    // Even a pre-existing owner repository may have linked indexes/refs or
    // object alternates. Host Git must not follow those outside the workspace.
    let entries = 0;
    async function metadata(directory: string, depth: number): Promise<void> {
      if (depth > 8) refuse();
      for await (const entry of await opendir(directory)) {
        if (++entries > 6000 || signal.aborted) refuse();
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || path === join(cwd, ".git", "objects", "info", "alternates")) refuse();
        if (info.isDirectory()) await metadata(path, depth + 1);
      }
    }
    await metadata(join(cwd, ".git"), 0);
    // Repository-provided includes, filters, aliases, ssh commands, credentials
    // and URL rewrites are not part of the bounded developer tool contract.
    const config = await git(cwd, ["config", "--local", "--no-includes", "--null", "--list"], signal);
    for (const entry of config.stdout.split("\0").filter(Boolean)) {
      if (!SAFE_CONFIG.test(entry.split("\n", 1)[0]!)) refuse();
    }
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).stdout.trim();
    if (top !== cwd) refuse();
    const url = (await git(cwd, ["config", "--local", "--get", "remote.origin.url"], signal)).stdout.trim();
    const remote = /^(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?$/.exec(url)?.[1];
    if (!remote || !REPOSITORY.test(remote) || remote.includes("..")) refuse();
    const head = (await git(cwd, ["rev-parse", "HEAD"], signal)).stdout.trim();
    const branch = (await git(cwd, ["branch", "--show-current"], signal)).stdout.trim();
    if (!SHA.test(head) || branch.length > 120) refuse();
    return { cwd, remote, head, branch, url: url.startsWith("https:") ? `https://github.com/${remote}.git` : `git@github.com:${remote}.git` };
  }
  async function identity(signal: AbortSignal) {
    const value = async (key: string) => (await run(deps.homePath, "git", ["config", "--global", "--get", key], signal, ownerEnv)).stdout.trim();
    const [name, email] = await Promise.all([value("user.name"), value("user.email")]);
    if (!z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/).safeParse(name).success || !z.email().max(320).safeParse(email).success) refuse();
    return { name, email };
  }
  async function fileSnapshots(cwd: string, files: string[], signal: AbortSignal) {
    const snapshots = [];
    for (const file of files) {
      const target = await pathWithin(cwd, file, true);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1024 * 1024) refuse();
        const bytes = await handle.readFile();
        if (bytes.length > 1024 * 1024) refuse();
        // Bind raw owner bytes separately from Git's built-in normalization.
        // Repository/global executable filters remain prohibited by config.
        const attributes = (await git(cwd, ["check-attr", "-z", "--all", "--", file], signal)).stdout;
        const cleanBlob = (await git(cwd, ["hash-object", `--path=${file}`, "--", file], signal)).stdout.trim();
        if (!SHA.test(cleanBlob)) refuse();
        snapshots.push({ file, attributes, cleanBlob, mode: info.mode & 0o111 ? "100755" : "100644",
          blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") });
      } finally { await handle.close(); }
    }
    return snapshots;
  }
  const filesFingerprint = (snapshots: Awaited<ReturnType<typeof fileSnapshots>>) => createHash("sha256").update(JSON.stringify(snapshots)).digest("hex");
  async function inspect(root: string, action: GithubDeveloperAction, signal: AbortSignal): Promise<GithubDeveloperPlan> {
    const checked = GithubDeveloperActionSchema.safeParse(action);
    if (!checked.success) refuse();
    const readiness = await deps.status(signal);
    if (!readiness.ready || !readiness.user || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(readiness.user)) throw new BotBrokerActionError("not_granted");
    if (action.action === "clone") {
      const target = await pathWithin(root, action.path, true);
      try { await lstat(target); refuse(); } catch (error: unknown) { if (!isMissing(error)) throw error; }
      return { account: readiness.user, repository: action.repository };
    }
    if (!action.path) return { account: readiness.user };
    const repo = await repository(root, action.path, signal);
    if ("expectedHead" in action && action.expectedHead !== repo.head) refuse();
    if (!["status", "branch"].includes(action.action) && !DEVELOPMENT_BRANCH.test(repo.branch)) refuse();
    return { account: readiness.user, repository: repo.remote, head: repo.head, branch: repo.branch,
      ...(action.action === "commit" ? { filesFingerprint: filesFingerprint(await fileSnapshots(repo.cwd, action.files, signal)), author: await identity(signal) } : {}) };
  }
  async function execute(root: string, input: GithubDeveloperAction, signal: AbortSignal, guard?: { plan: GithubDeveloperPlan; assertCurrent(): Promise<void> }): Promise<Result> {
    const checked = GithubDeveloperActionSchema.safeParse(input);
    if (!checked.success) refuse();
    const action = checked.data;
    if (action.action === "status") {
      const state = await deps.status(signal);
      if (!action.path) return { ready: state.ready, account: state.user };
      const repo = await repository(root, action.path, signal);
      const changes = (await git(repo.cwd, ["status", "--porcelain", "-z", "--untracked-files=normal"], signal)).stdout;
      if (changes.split("\0").length > 201) throw new BotBrokerActionError("unavailable");
      return { ready: state.ready, account: state.user, repository: repo.remote, path: action.path, head: repo.head, branch: repo.branch,
        changes: changes.split("\0").filter(Boolean).slice(0, 64).map(line => line.slice(0, 256)), truncated: changes.split("\0").length > 65 };
    }
    const key = `${root}/${action.path}`;
    if (locks.has(key) || locks.size >= 64) throw new BotBrokerActionError("unavailable");
    locks.add(key);
    let effectStarted = false;
    try {
      const plan = await inspect(root, action, signal);
      if (guard && JSON.stringify(guard.plan) !== JSON.stringify(plan)) throw new BotBrokerActionError("denied");
      await guard?.assertCurrent();
      if (signal.aborted) throw new BotBrokerActionError("stale_generation");
      if (action.action === "clone") {
        const target = await pathWithin(root, action.path, true);
        await mkdir(target, { mode: 0o750 }); // exclusive: never overwrite another project.
        const created = await lstat(target);
        let staging: string | undefined;
        let published = false;
        try {
          staging = await stagingFiles.create("clone");
          if ((await lstat(staging)).dev !== created.dev) refuse();
          await guard?.assertCurrent();
          await git(staging, ["clone", "--no-local", "--", `git@github.com:${action.repository}.git`, "."], signal);
          await guard?.assertCurrent();
          const reserved = await lstat(target);
          if (reserved.isSymbolicLink() || reserved.ino !== created.ino || reserved.dev !== created.dev) refuse();
          await rename(staging, target); // Cannot replace a nonempty directory.
          published = true;
          const repo = await repository(root, action.path, signal);
          return { account: plan.account, repository: repo.remote, path: action.path, head: repo.head, branch: repo.branch };
        } catch (error: unknown) {
          // Never recursively remove the visible target: another action may
          // have written there while clone was pending. rmdir preserves it.
          try {
            const current = await lstat(target);
            if (!current.isSymbolicLink() && current.ino === created.ino && current.dev === created.dev) await rmdir(target);
          } catch (cleanup: unknown) {
            if (!isMissing(cleanup) && !(cleanup instanceof Error && "code" in cleanup && ["ENOTEMPTY", "EEXIST"].includes(String(cleanup.code)))) throw cleanup;
          }
          if (published && error instanceof BotBrokerActionError) throw new Error("GitHub clone outcome unconfirmed");
          throw error;
        } finally { if (staging) await stagingFiles.remove(staging); }
      }
      const repo = await repository(root, action.path, signal);
      // The authorization check above can wait while Terminal changes the
      // branch or origin. Only use a snapshot that still matches approval.
      if (repo.head !== plan.head || repo.branch !== plan.branch || repo.remote !== plan.repository) {
        throw new BotBrokerActionError("denied");
      }
      await guard?.assertCurrent();
      if (action.action === "branch") {
        effectStarted = true;
        await git(repo.cwd, ["switch", "--no-guess", "-c", action.name, repo.head], signal);
        return { account: plan.account, head: repo.head, branch: action.name };
      }
      if (action.action === "commit") {
        const author = await identity(signal);
        if (JSON.stringify(author) !== JSON.stringify(plan.author)) refuse();
        const snapshots = await fileSnapshots(repo.cwd, action.files, signal);
        if (filesFingerprint(snapshots) !== plan.filesFingerprint) refuse();
        const staging = await stagingFiles.create("index");
        try {
          const index = join(staging, "index");
          await git(repo.cwd, ["read-tree", repo.head], signal, undefined, index);
          await git(repo.cwd, ["add", "--", ...action.files], signal, undefined, index);
          const staged = (await git(repo.cwd, ["ls-files", "--stage", "-z", "--", ...action.files], signal, undefined, index)).stdout;
          for (const snapshot of snapshots) if (!staged.split("\0").includes(`${snapshot.mode} ${snapshot.cleanBlob} 0\t${snapshot.file}`)) refuse();
          const tree = (await git(repo.cwd, ["write-tree"], signal, undefined, index)).stdout.trim();
          if (!SHA.test(tree)) refuse();
          const next = (await git(repo.cwd, ["commit-tree", tree, "-p", repo.head, "-m", action.message], signal, author, index)).stdout.trim();
          if (!SHA.test(next)) refuse();
          await guard?.assertCurrent();
          // Recheck both raw bytes and resolved attributes after staging; a
          // Terminal edit must not alter the approved conversion or contents.
          if (filesFingerprint(await fileSnapshots(repo.cwd, action.files, signal)) !== plan.filesFingerprint) refuse();
          if ((await git(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], signal)).stdout.trim() !== `refs/heads/${repo.branch}`) refuse();
          // Compare-and-swap protects the approved parent even against an owner
          // Terminal commit; the in-process lock alone would not do so.
          effectStarted = true;
          await git(repo.cwd, ["update-ref", "--no-deref", `refs/heads/${repo.branch}`, next, repo.head], signal);
          if ((await git(repo.cwd, ["symbolic-ref", "--quiet", "HEAD"], signal)).stdout.trim() !== `refs/heads/${repo.branch}`) throw new Error("GitHub commit index reconciliation required");
          // Reconcile only the explicitly committed paths, retaining unrelated
          // staged entries and all working-tree bytes. Other Terminal writers
          // still use Git's index/ref locks; failures are unknown, never replayed.
          await git(repo.cwd, ["reset", "--quiet", next, "--", ...action.files], signal);
          return { account: plan.account, head: next, branch: repo.branch, author: `${author.name} <${author.email}>` };
        } finally { await stagingFiles.remove(staging); }
      }
      const url = repo.url;
      if (action.action === "push") {
        effectStarted = true;
        await git(repo.cwd, ["push", "--no-verify", "--", url, `${repo.head}:refs/heads/${repo.branch}`], signal);
        const remote = (await git(repo.cwd, ["ls-remote", "--heads", url, `refs/heads/${repo.branch}`], signal)).stdout.trim();
        if (remote !== `${repo.head}\trefs/heads/${repo.branch}`) throw new Error("GitHub push outcome unconfirmed");
        return { account: plan.account, head: repo.head, branch: repo.branch, pushed: true };
      }
      let created = false;
      const list = async () => {
        const response = await run(repo.cwd, "gh", ["pr", "list", "--repo", repo.remote, "--head", repo.branch, "--base", action.base,
          "--state", "open", "--json", "number,url,author,isDraft,headRefOid"], signal);
        const rows = z.array(z.object({ number: z.number().int().positive(), url: z.string(), author: z.object({ login: z.string() }), isDraft: z.boolean(), headRefOid: z.string().regex(SHA) })).max(1).parse(JSON.parse(response.stdout));
        const row = rows[0];
        if (row && (!row.isDraft || row.url.toLowerCase() !== `https://github.com/${repo.remote}/pull/${row.number}`.toLowerCase() || row.author.login.toLowerCase() !== plan.account.toLowerCase() || row.headRefOid !== repo.head)) {
          if (created) throw new Error("GitHub pull request outcome unconfirmed");
          refuse();
        }
        return row;
      };
      let pr = await list();
      if (!pr) {
        await guard?.assertCurrent();
        const remoteHead = (await git(repo.cwd, ["ls-remote", "--heads", url, `refs/heads/${repo.branch}`], signal)).stdout.trim();
        if (remoteHead !== `${repo.head}\trefs/heads/${repo.branch}`) refuse();
        created = true;
        effectStarted = true;
        await run(repo.cwd, "gh", ["pr", "create", "--draft", "--repo", repo.remote, "--head", repo.branch,
          "--base", action.base, "--title", action.title, "--body", action.body], signal);
        pr = await list();
      }
      if (!pr) throw new Error("GitHub pull request outcome unconfirmed");
      return { account: plan.account, head: repo.head, branch: repo.branch, pullRequest: pr.url, draft: pr.isDraft };
    } catch (error: unknown) {
      // A cancellation or revalidation refusal after mutation may arrive before
      // readback. The durable broker must retain an unknown effect, not mistake
      // this typed error for a refusal decided before any commit/push/PR.
      if (effectStarted && error instanceof BotBrokerActionError) throw new Error("GitHub action outcome unconfirmed");
      throw error;
    } finally { locks.delete(key); }
  }
  return { inspect, execute, close: () => stagingFiles.close() };
}
export type GithubDeveloperService = ReturnType<typeof createGithubDeveloperService>;
