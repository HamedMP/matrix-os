import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectSetupDraftSchema } from "@matrix-os/contracts";
import { initialProjectSetup, transitionProjectSetup, applyProjectSetupGeneration } from "../../packages/gateway/src/chat/project-setup-state.js";
import { inspectProjectSetupFiles, saveProjectSetupFiles } from "../../packages/gateway/src/chat/project-setup-files.js";
import { openProjectSetupWorkspace, type ProjectSetupWorkspace } from "../../packages/gateway/src/chat/project-setup-workspace.js";

const manifest = "---\nname: release-check\ndescription: Review a release\n---\n\nCheck the release notes.\n";
const skillPath = ".agents/skills/release-check/SKILL.md";
function draft(withSkill = false) {
  let current = initialProjectSetup("chat_setup", "project_a", "A portfolio", "msg_question");
  current = transitionProjectSetup(current, { type: "answer", text: "Run the relevant checks" }).draft;
  current = transitionProjectSetup(current, withSkill
    ? { type: "stage_skill", content: manifest }
    : { type: "choose_skill", choice: "skip" }).draft;
  return transitionProjectSetup(current, { type: "choose_mcp", choice: "skip" }).draft;
}
function workspace(files = new Map<string, string>()): ProjectSetupWorkspace & { files: Map<string, string> } {
  return { files, executionRootFingerprint: "b".repeat(64), fingerprint: "a".repeat(64), projectSlug: "portfolio", read: async p => files.get(p) ?? null,
    revalidate: vi.fn(async () => {}), close: vi.fn(async () => {}), create: vi.fn(async (p, c) => {
      if (files.has(p)) throw Object.assign(new Error("Exists"), { code: "EEXIST" });
      files.set(p, c);
    }) };
}
describe("reviewed setup file creation", () => {
  it("keeps review read-only then saves canonical guidance before its companion", async () => {
    const ws = workspace(); const reviewed = await inspectProjectSetupFiles(ws, draft());
    expect(ws.create).not.toHaveBeenCalled();
    const saved = await saveProjectSetupFiles(ws, reviewed);
    expect(saved.step).toBe("saved");
    expect([...ws.files.keys()]).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(ws.files.get("CLAUDE.md")).toBe("@AGENTS.md\n");
  });
  it("preserves concurrently created and independent existing files", async () => {
    const ws = workspace(); const reviewed = await inspectProjectSetupFiles(ws, draft());
    ws.files.set("AGENTS.md", "Owner content");
    const saved = await saveProjectSetupFiles(ws, reviewed);
    expect(saved.step).toBe("review"); expect(saved.proposals[0]?.status).toBe("conflict");
    expect(ws.files.get("AGENTS.md")).toBe("Owner content"); expect(ws.files.has("CLAUDE.md")).toBe(false);
    expect(ws.create).not.toHaveBeenCalled();
  });
  it("reviews existing long guidance and only creates the missing companion", async () => {
    const existing = "# Owner guidance\n\n" + "Keep this policy. ".repeat(700);
    const ws = workspace(new Map([["AGENTS.md", existing]]));
    const reviewed = await inspectProjectSetupFiles(ws, draft());
    expect(reviewed.proposals[0]).toMatchObject({ content: existing, status: "already_present" });
    expect(ws.create).not.toHaveBeenCalled();
    const result = await saveProjectSetupFiles(ws, reviewed);
    expect(result.step).toBe("saved"); expect(ws.files.get("AGENTS.md")).toBe(existing);
    expect(ws.create).toHaveBeenCalledExactlyOnceWith("CLAUDE.md", "@AGENTS.md\n");
  });
  it("preserves an independent CLAUDE.md after full review", async () => {
    const ws = workspace(new Map([["CLAUDE.md", "Independent Claude preferences"]]));
    const reviewed = await inspectProjectSetupFiles(ws, draft());
    const result = await saveProjectSetupFiles(ws, reviewed);
    expect(result.step).toBe("saved"); expect(ws.files.get("CLAUDE.md")).toBe("Independent Claude preferences");
    expect(vi.mocked(ws.create).mock.calls.map(call => call[0])).toEqual(["AGENTS.md"]);
  });
  it("reports a no-follow refusal during Review and saves unrelated proposals", async () => {
    const ws = workspace(new Map([["AGENTS.md", "Existing guidance"]]));
    const read = ws.read;
    ws.read = async path => {
      if (path === "CLAUDE.md") throw Object.assign(new Error("Symlink refused"), { code: "ELOOP" });
      return read(path);
    };
    const reviewed = ProjectSetupDraftSchema.parse(await inspectProjectSetupFiles(ws, draft(true)));
    expect(reviewed.step).toBe("review");
    expect(reviewed.proposals.map(file => file.status)).toEqual(["already_present", "symlink_skipped", "pending"]);
    expect(ws.create).not.toHaveBeenCalled();
    const saved = ProjectSetupDraftSchema.parse(await saveProjectSetupFiles(ws, reviewed));
    expect(saved.step).toBe("saved");
    expect(saved.proposals.map(file => file.status)).toEqual(["already_present", "symlink_skipped", "saved"]);
    expect(ws.create).toHaveBeenCalledExactlyOnceWith(skillPath, manifest);
  });
  it.each(["regular file", "missing"] as const)("requires fresh Review after a skipped link changes (%s)", async replacement => {
    const ws = workspace();
    const read = ws.read;
    let isLink = true;
    ws.read = async path => {
      if (path === "AGENTS.md" && isLink) throw Object.assign(new Error("Symlink refused"), { code: "ELOOP" });
      return read(path);
    };
    const reviewed = await inspectProjectSetupFiles(ws, draft());
    expect(() => transitionProjectSetup(reviewed, { type: "review_file", path: "AGENTS.md", content: "Override" })).toThrow();
    isLink = false;
    if (replacement === "regular file") ws.files.set("AGENTS.md", "New owner guidance");
    const beforeRefresh = await saveProjectSetupFiles(ws, reviewed);
    expect(beforeRefresh.proposals[0]?.status).toBe("conflict");
    expect(ws.create).not.toHaveBeenCalled();
    const refreshed = await inspectProjectSetupFiles(ws, reviewed);
    expect(refreshed.proposals[0]?.status).toBe(replacement === "regular file" ? "already_present" : "pending");
    if (replacement === "regular file") expect(refreshed.proposals[0]?.content).toBe("New owner guidance");
  });
  it("does not create a companion if previously reviewed guidance becomes a symlink", async () => {
    const ws = workspace(new Map([["AGENTS.md", ""]]));
    const reviewed = await inspectProjectSetupFiles(ws, draft(true));
    expect(reviewed.proposals[0]).toMatchObject({ content: "", status: "already_present" });
    const read = ws.read;
    ws.read = async path => {
      if (path === "AGENTS.md") throw Object.assign(new Error("Symlink refused"), { code: "ELOOP" });
      return read(path);
    };
    const saved = ProjectSetupDraftSchema.parse(await saveProjectSetupFiles(ws, reviewed));
    expect(saved.step).toBe("review");
    expect(saved.proposals.map(file => file.status)).toEqual(["symlink_skipped", "conflict", "saved"]);
    expect(ws.create).toHaveBeenCalledExactlyOnceWith(skillPath, manifest);
  });
  it.runIf(process.platform === "linux")("preserves an existing relative CLAUDE.md link in a pinned checkout", async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "setup-symlink-"));
    try {
      const root = join(home, "project-a");
      await mkdir(root);
      await writeFile(join(root, "AGENTS.md"), "Existing guidance");
      await symlink("AGENTS.md", join(root, "CLAUDE.md"));
      const resolved = { ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: "a".repeat(64),
        primaryWorkspaceRoot: root, projectSlug: "project-a" };
      const roots = { resolve: async () => resolved, revalidate: async () => resolved };
      const ws = await openProjectSetupWorkspace(roots, home, { type: "personal", ownerId: "owner" }, "project_a");
      try {
        const reviewed = await inspectProjectSetupFiles(ws, draft(true));
        expect(reviewed.proposals[1]).toMatchObject({ path: "CLAUDE.md", status: "symlink_skipped" });
        expect(reviewed.proposals[1]?.content).not.toContain("Existing guidance");
        const saved = await saveProjectSetupFiles(ws, reviewed);
        expect(saved.step).toBe("saved");
        expect(await readlink(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
        expect(await readFile(join(root, skillPath), "utf8")).toBe(manifest);
        expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("Existing guidance");
      } finally {
        await ws.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("skips only an unavailable Skill destination without concealing unexpected read failures", async () => {
    const ws = workspace();
    const read = ws.read;
    const unavailable = Object.assign(new Error("Directory unavailable"), { code: "ENOTDIR" });
    ws.read = async path => path === skillPath ? Promise.reject(unavailable) : read(path);
    const reviewed = ProjectSetupDraftSchema.parse(await inspectProjectSetupFiles(ws, draft(true)));
    expect(reviewed.proposals[2]).toEqual({ path: skillPath, status: "destination_unavailable", content: manifest });
    expect(ws.create).not.toHaveBeenCalled();
    const saved = ProjectSetupDraftSchema.parse(await saveProjectSetupFiles(ws, reviewed));
    expect(saved.step).toBe("saved");
    expect(saved.proposals.map(file => file.status)).toEqual(["saved", "saved", "destination_unavailable"]);
    expect(ws.files.has(skillPath)).toBe(false);

    const unexpected = Object.assign(new Error("Read failed"), { code: "EIO" });
    ws.read = async path => path === skillPath ? Promise.reject(unexpected) : read(path);
    await expect(inspectProjectSetupFiles(ws, draft(true))).rejects.toBe(unexpected);
  });
  it.runIf(process.platform === "linux").each([
    [".agents", "link"], [".agents/skills", "link"], [".agents/skills/release-check", "link"],
    [".agents/skills", "file"],
  ])("saves guidance while preserving an obstructed Skill directory at %s (%s)", async (obstruction, kind) => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "setup-skill-directory-"));
    try {
      const root = join(home, "project-a");
      const blockedPath = join(root, obstruction);
      const target = join(root, "skill-target");
      const targetManifest = join(target, skillPath.slice(obstruction.length + 1));
      const existing = "Keep the owner's content";
      await mkdir(dirname(blockedPath), { recursive: true });
      await mkdir(dirname(targetManifest), { recursive: true });
      await writeFile(targetManifest, existing);
      if (kind === "link") await symlink(target, blockedPath);
      else await writeFile(blockedPath, existing);
      const resolved = { ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: "a".repeat(64),
        primaryWorkspaceRoot: root, projectSlug: "project-a" };
      const roots = { resolve: async () => resolved, revalidate: async () => resolved };
      const ws = await openProjectSetupWorkspace(roots, home, { type: "personal", ownerId: "owner" }, "project_a");
      try {
        const reviewed = await inspectProjectSetupFiles(ws, draft(true));
        expect(reviewed.proposals.map(file => file.status)).toEqual(["pending", "pending", "destination_unavailable"]);
        expect(reviewed.proposals[2]?.content).toBe(manifest);
        await expect(readFile(join(root, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
        const saved = await saveProjectSetupFiles(ws, reviewed);
        expect(saved.step).toBe("saved");
        expect(saved.proposals.map(file => file.status)).toEqual(["saved", "saved", "destination_unavailable"]);
        expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(reviewed.proposals[0]?.content);
        expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
        if (kind === "link") expect(await readlink(blockedPath)).toBe(target);
        else expect(await readFile(blockedPath, "utf8")).toBe(existing);
        expect(await readFile(targetManifest, "utf8")).toBe(existing);
      } finally {
        await ws.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("retains a partial success and safely retries the missing companion", async () => {
    const ws = workspace(); const reviewed = await inspectProjectSetupFiles(ws, draft());
    vi.mocked(ws.create).mockImplementationOnce(async (p, c) => { ws.files.set(p, c); }).mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { code: "EIO" }));
    const partial = await saveProjectSetupFiles(ws, reviewed);
    expect(partial.proposals.map(p => p.status)).toEqual(["saved", "failed"]);
    const retry = await saveProjectSetupFiles(ws, partial);
    expect(retry.step).toBe("saved"); expect(retry.proposals[0]?.status).toBe("already_present");
  });
  it("keeps an oversized new proposal reviewable and refuses its create until revised", async () => {
    const ws = workspace();
    const generated = applyProjectSetupGeneration(draft(), JSON.stringify({ guidance: "x".repeat(8193) }));
    const reviewed = await inspectProjectSetupFiles(ws, generated);
    expect(reviewed.proposals[0]?.content).toHaveLength(8193);
    expect(ws.create).not.toHaveBeenCalled();
    const attempted = await saveProjectSetupFiles(ws, reviewed);
    expect(attempted.step).toBe("review");
    expect(attempted.proposals[0]?.status).toBe("failed");
    expect(attempted.proposals[0]?.content).toHaveLength(8193);
    expect(ws.create).not.toHaveBeenCalled();
    const revised = transitionProjectSetup(attempted, { type: "review_file", path: "AGENTS.md", content: "x".repeat(8192) }).draft;
    const saved = await saveProjectSetupFiles(ws, await inspectProjectSetupFiles(ws, revised));
    expect(saved.step).toBe("saved");
    expect(ws.files.get("AGENTS.md")).toHaveLength(8192);
  });
  it("rejects unsafe proposal substitution even when the broad file contract recognizes it", async () => {
    const ws = workspace(); const changed = draft(); changed.proposals[0] = { path: ".mcp.json", content: "{}", status: "pending" };
    await expect(inspectProjectSetupFiles(ws, changed)).rejects.toThrow(); expect(ws.create).not.toHaveBeenCalled();
  });
});
