import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { opendir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { LocalChatPreviewError, LocalChatTransferError } from "@matrix-os/contracts/local-chat-import";
import { openLocalChatSource } from "./local-chat-source.js";
const exec = promisify(execFile);
type Git = (cwd: string, args: string[]) => Promise<string>;
const defaultGit: Git = async (cwd, args) => (await exec("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 8192, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
interface Entry {
    harness: "codex" | "claude";
    path: string;
    sourceKind: "active" | "archived" | "subagent";
    rawBytes: number;
    sourceId?: string;
    sourceAgentId?: string;
    recordedDirectory?: string;
    repositoryUrl?: string;
    commit?: string;
    association: "matched" | "unrelated" | "unresolved";
    associationBasis?:"current_directory"|"recorded_git";
    recordedRemoteChanged?:true;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max = 4096): string | undefined { return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined; }
function remote(value: unknown): string | undefined {
    const raw = text(value);
    if (!raw)
        return undefined;
    try {
        const url = new URL(raw);
        if (!["https:", "ssh:", "git:"].includes(url.protocol))
            return undefined;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch (error: unknown) {
        if (!(error instanceof TypeError))
            throw error;
        return /^git@[A-Za-z0-9.-]+:[^\s?#]+$/.test(raw) ? raw.replace(/^git@([^:]+):/, "ssh://$1/") : undefined;
    }
}
function comparable(value: string) { const url = new URL(value); return url.host.toLowerCase() + url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, ""); }
function expectedProbeFailure(error: unknown) { return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", 1, 128].includes(error.code as never) && !("killed" in error && error.killed); }
function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
/** Discovery reads bounded metadata only. Index names, branch names, and parent folders confer no repository identity. */
export async function discoverLocalChatFiles(options: {
    codexRoot?: string;
    claudeRoot?: string;
    project?: string;
    git?: Git;
    resolveDirectory?: (path: string) => Promise<string>;
    signal?: AbortSignal;
} = {}) {
    const git = options.git ?? defaultGit;
    const directory = options.resolveDirectory ?? realpath;
    const signal = options.signal ?? AbortSignal.timeout(10 * 60000);
    let scanned = 0;
    let skipped = 0;
    const files: Entry[] = [];
    const issues:Array<{path:string;code:"unsupported"|"changed"|"unreadable"}>=[];
    let projectCommon: string | undefined;
    let projectRemote: string | undefined;
    if (options.project) {
        const project = await directory(resolve(options.project));
        projectCommon = await directory(resolve(project, await git(project, ["rev-parse", "--git-common-dir"])));
        try {
            projectRemote = remote(await git(project, ["remote", "get-url", "origin"]));
        }
        catch (error: unknown) {
            if (!expectedProbeFailure(error)&&!(error instanceof Error&&"code" in error&&error.code===2&&"stderr" in error&&typeof error.stderr==="string"&&/No such remote/.test(error.stderr)))
                throw error;
        }
    }
    async function associate(entry: Entry) {
        if (!options.project || !projectCommon)
            return;
        if (entry.recordedDirectory) {
            try {
                const cwd = await directory(entry.recordedDirectory);
                const common = await directory(resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"])));
                if (common === projectCommon) {
                    entry.association = "matched";entry.associationBasis="current_directory";
                    if(entry.repositoryUrl&&projectRemote&&comparable(entry.repositoryUrl)!==comparable(projectRemote))entry.recordedRemoteChanged=true;
                    return;
                }
            }
            catch (error: unknown) {
                if (!expectedProbeFailure(error))
                    throw error; /* Missing or non-Git historical cwd remains unresolved. */
            }
        }
        if (entry.repositoryUrl && projectRemote && comparable(entry.repositoryUrl) !== comparable(projectRemote)) {
            entry.association = "unrelated";
            return;
        }
        if (entry.repositoryUrl && projectRemote && comparable(entry.repositoryUrl) === comparable(projectRemote) && entry.commit) {
            try {
                await git(resolve(options.project), ["cat-file", "-e", `${entry.commit}^{commit}`]);
                entry.association = "matched";entry.associationBasis="recorded_git";
            }
            catch (error: unknown) {
                if (!expectedProbeFailure(error))
                    throw error; /* Recorded commit absent from this checkout is unresolved. */
            }
        }
    }
    async function inspect(path: string, harness: Entry["harness"], sourceKind: Entry["sourceKind"]) {
        const source = await openLocalChatSource(path);
        try {
            const bytes = await source.read(0, Math.min(source.rawSize, 2 * 1024 ** 2), signal);
            const lines = new TextDecoder().decode(bytes).split("\n").slice(0, 32);
            const entry: Entry = { path, harness, sourceKind, rawBytes: source.rawSize, association: "unresolved" };
            for (const line of lines) {
                let value: Record<string, unknown>;
                try {
                    value = record(JSON.parse(line));
                }
                catch (error: unknown) {
                    if (!(error instanceof SyntaxError))
                        throw error;
                    continue;
                }
                const payload = record(value.payload);
                const meta = value.type === "session_meta" ? payload : value;
                const id = harness === "claude" ? value.sessionId : meta.id ?? meta.session_id;
                if (!entry.sourceId && z.uuid().safeParse(id).success)
                    entry.sourceId = id as string;
                entry.sourceAgentId ??= text(value.agentId, 512);
                const subagent=record(record(meta.source).subagent);
                if(Object.keys(subagent).length){entry.sourceKind="subagent";entry.sourceAgentId??=text(record(subagent.thread_spawn).agent_path,512)??entry.sourceId;}
                entry.recordedDirectory ??= text(meta.cwd);
                entry.repositoryUrl ??= remote(record(meta.git).repository_url);
                const commit = text(record(meta.git).commit_hash, 64);
                if (commit && /^[a-f0-9]{40,64}$/.test(commit))
                    entry.commit ??= commit;
                if (entry.sourceId && entry.recordedDirectory)
                    break;
            }
            await associate(entry);
            files.push(entry);
        }
        finally {
            await source.close();
        }
    }
    async function walk(root: string, harness: Entry["harness"], kind: Entry["sourceKind"], depth = 0) {
        signal.throwIfAborted();
        if (depth > 16)
            throw new Error("Transcript discovery limit reached");
        let entries: Awaited<ReturnType<typeof opendir>>;
        try {
            const info = await lstat(root);
            if (info.isSymbolicLink() || !info.isDirectory()) {
                skipped++;
                return;
            }
            entries = await opendir(root);
        }
        catch (error: unknown) {
            if (missing(error))
                return;
            throw error;
        }
        for await (const entry of entries) {
            signal.throwIfAborted();
            if (++scanned > 20000)
                throw new Error("Transcript discovery limit reached");
            if (entry.isSymbolicLink()) {
                skipped++;
                continue;
            }
            const path = join(root, entry.name);
            if (entry.isDirectory())
                await walk(path, harness, kind, depth + 1);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                if (files.length >= 10000)
                    throw new Error("Transcript discovery limit reached");
                try{await inspect(path, harness, harness === "claude" && path.split(/[\\/]/).includes("subagents") ? "subagent" : kind);}
                catch(error:unknown){
                  let code:"unsupported"|"changed"|"unreadable";
                  if(error instanceof LocalChatPreviewError)code=error.code==="source_changed"?"changed":"unsupported";
                  else if(error instanceof LocalChatTransferError&&error.code==="source_changed")code="changed";
                  else if(error instanceof Error&&"code" in error&&["ENOENT","EACCES","EPERM","EIO","ENOTDIR"].includes(error.code as never))code="unreadable";
                  else throw error;
                  if(issues.length>=10_000)throw new Error("Transcript discovery limit reached");issues.push({path,code});skipped++;
                }
            }
        }
    }
    const codex = options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const claude = options.claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    await walk(join(codex, "sessions"), "codex", "active");
    await walk(join(codex, "archived_sessions"), "codex", "archived");
    await walk(join(claude, "projects"), "claude", "active");
    return { files, skipped, issues };
}
