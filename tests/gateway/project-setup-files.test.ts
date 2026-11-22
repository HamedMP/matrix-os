import { describe, expect, it, vi } from "vitest";
import { initialProjectSetup, transitionProjectSetup } from "../../packages/gateway/src/chat/project-setup-state.js";
import { inspectProjectSetupFiles, saveProjectSetupFiles } from "../../packages/gateway/src/chat/project-setup-files.js";
import type { ProjectSetupWorkspace } from "../../packages/gateway/src/chat/project-setup-workspace.js";

function draft() {
  let current = initialProjectSetup("chat_setup", "project_a", "A portfolio", "msg_question");
  current = transitionProjectSetup(current, { type: "answer", text: "Run the relevant checks" }).draft;
  current = transitionProjectSetup(current, { type: "choose_skill", choice: "skip" }).draft;
  return transitionProjectSetup(current, { type: "choose_mcp", choice: "skip" }).draft;
}
function workspace(files = new Map<string, string>()): ProjectSetupWorkspace & { files: Map<string, string> } {
  return { files, fingerprint: "a".repeat(64), projectSlug: "portfolio", read: async p => files.get(p) ?? null,
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
  it("retains a partial success and safely retries the missing companion", async () => {
    const ws = workspace(); const reviewed = await inspectProjectSetupFiles(ws, draft());
    vi.mocked(ws.create).mockImplementationOnce(async (p, c) => { ws.files.set(p, c); }).mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { code: "EIO" }));
    const partial = await saveProjectSetupFiles(ws, reviewed);
    expect(partial.proposals.map(p => p.status)).toEqual(["saved", "failed"]);
    const retry = await saveProjectSetupFiles(ws, partial);
    expect(retry.step).toBe("saved"); expect(retry.proposals[0]?.status).toBe("already_present");
  });
  it("rejects unsafe proposal substitution even when the broad file contract recognizes it", async () => {
    const ws = workspace(); const changed = draft(); changed.proposals[0] = { path: ".mcp.json", content: "{}", status: "pending" };
    await expect(inspectProjectSetupFiles(ws, changed)).rejects.toThrow(); expect(ws.create).not.toHaveBeenCalled();
  });
});
