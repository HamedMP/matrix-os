import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLocalChatFiles } from "../../packages/sync-client/src/import/discovery.js";
let dir: string;
afterEach(async () => { if (dir)
    await rm(dir, { recursive: true, force: true }); });
const id = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
describe("bounded local transcript discovery", () => {
    it("enumerates explicit active/archive/agent roots without reading credentials or global history", async () => {
        dir = await mkdtemp(join(tmpdir(), "matrix-import-discovery-"));
        const codex = join(dir, "codex");
        const claude = join(dir, "claude");
        await mkdir(join(codex, "sessions", "2026"), { recursive: true });
        await mkdir(join(codex, "archived_sessions"));
        await mkdir(join(claude, "projects", "anything", "subagents"), { recursive: true });
        const meta = JSON.stringify({ type: "session_meta", payload: { id, cwd: "/private/project", git: { repository_url: "https://secret@github.com/example/repo.git", commit_hash: "a".repeat(40) } } }) + "\n";
        await writeFile(join(codex, "sessions", "2026", "one.jsonl"), meta);
        await writeFile(join(codex, "archived_sessions", "two.jsonl"), meta);
        await writeFile(join(codex, "history.jsonl"), "private global input");
        await writeFile(join(codex, "auth.json"), "secret");
        await writeFile(join(claude, "projects", "anything", "subagents", "agent-x.jsonl"), JSON.stringify({ type: "user", sessionId: id, agentId: "agent-x", cwd: "/private/project", message: { content: "PRIVATE CONTENT MUST NOT BE RETURNED" } }) + "\n");
        await symlink(join(codex, "sessions", "2026", "one.jsonl"), join(codex, "sessions", "link.jsonl"));
        const result = await discoverLocalChatFiles({ codexRoot: codex, claudeRoot: claude });
        expect(result.files).toHaveLength(3);
        expect(result.files.map(value => value.sourceKind).sort()).toEqual(["active", "archived", "subagent"]);
        expect(JSON.stringify(result)).not.toContain("PRIVATE CONTENT");
        expect(JSON.stringify(result)).not.toContain("secret@");
        expect(result.files.every(value => value.association === "unresolved")).toBe(true);
    });
    it("uses exact Git common-directory evidence and rejects recorded remote conflicts", async () => {
        dir = await mkdtemp(join(tmpdir(), "matrix-import-discovery-"));
        const codex = join(dir, "codex");
        await mkdir(join(codex, "sessions"), { recursive: true });
        for (const [name, remote] of [["same", "https://github.com/example/repo.git"], ["other", "https://github.com/unrelated/repo.git"]])
            await writeFile(join(codex, "sessions", name + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id, cwd: "/work/repo", git: { repository_url: remote } } }) + "\n");
        const git = vi.fn(async (_cwd: string, args: string[]) => args.includes("remote") ? "https://github.com/example/repo.git" : args.includes("--git-common-dir") ? "/work/repo/.git" : "/work/repo");
        const result = await discoverLocalChatFiles({ codexRoot: codex, claudeRoot: join(dir, "missing"), project: "/work/repo", git, resolveDirectory: async (value) => value });
        expect(result.files.find(value => value.path.endsWith("same.jsonl"))?.association).toBe("matched");
        expect(result.files.find(value => value.path.endsWith("other.jsonl"))?.association).toBe("unrelated");
    });
});
