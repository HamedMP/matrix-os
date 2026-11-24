import { describe, expect, it } from "vitest";
import {
  ChatArtifactProviderEventSchema,
  FilePreviewDescriptorSchema,
  FileResourceRefSchema,
  classifyFilePreview,
  normalizeChatFileReference,
  canonicalChatFileScope,
  type CanonicalChatDetailResponse,
  type CanonicalChatExecutionRootRef,
} from "../../packages/contracts/src/index.js";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

function fileScopeDetail(projectId?: string, roots: CanonicalChatExecutionRootRef[] = [], activeIndex?: number): Pick<CanonicalChatDetailResponse, "record" | "runs"> {
  const snapshot = createCanonicalChatFixture("completed").snapshot;
  const { project: _project, providerBinding: _binding, activeRun: _active, ...chat } = snapshot.chat;
  const runs = roots.map((executionRoot, index) => ({ ...snapshot.runs[0]!, id: `run_scope_${index}`, executionRoot }));
  return { record: { chat, ...(projectId ? { projectId } : {}), ...(activeIndex === undefined ? {} : {
    activeRun: { runId: runs[activeIndex]!.id, turnId: runs[activeIndex]!.turnId, status: "running" as const },
  }) }, runs };
}

describe("canonical chat file scope", () => {
  it("waits for verified detail instead of defaulting an unresolved chat to Home", () => {
    expect(canonicalChatFileScope(null)).toEqual({ kind: "unavailable" });
  });
  it("uses owner Home for a global chat regardless of historical run roots", () => {
    expect(canonicalChatFileScope(fileScopeDetail(undefined, [{ kind: "worktree", projectId: "other", worktreeId: "wt_other" }]))).toEqual({ kind: "home" });
  });
  it("keeps a project without a run on its primary checkout", () => {
    expect(canonicalChatFileScope(fileScopeDetail("project_one"))).toEqual({ kind: "project", projectId: "project_one" });
  });
  it("uses the named active run even when a later array entry exists", () => {
    expect(canonicalChatFileScope(fileScopeDetail("project_one", [
      { kind: "worktree", projectId: "project_one", worktreeId: "wt_active" },
      { kind: "project", projectId: "project_one" },
    ], 0))).toEqual({ kind: "project", projectId: "project_one", worktreeId: "wt_active" });
  });
  it("uses the newest committed run when no run is active", () => {
    expect(canonicalChatFileScope(fileScopeDetail("project_one", [
      { kind: "project", projectId: "project_one" },
      { kind: "worktree", projectId: "project_one", worktreeId: "wt_latest" },
    ]))).toEqual({ kind: "project", projectId: "project_one", worktreeId: "wt_latest" });
  });
  it("does not fall back to the primary checkout when the active run is missing", () => {
    const value = fileScopeDetail("project_one", [{ kind: "project", projectId: "project_one" }], 0);
    value.record.activeRun!.runId = "run_missing";
    expect(canonicalChatFileScope(value)).toEqual({ kind: "unavailable" });
  });
  it.each([
    { kind: "worktree" as const, projectId: "other_project", worktreeId: "wt_other" },
    { kind: "bot_workspace" as const, botId: "bot_fixtureone" },
  ])("rejects a run root outside the chat project: $kind", root => {
    expect(canonicalChatFileScope(fileScopeDetail("project_one", [root]))).toEqual({ kind: "unavailable" });
  });
});

describe("file preview contracts", () => {
  it("classifies formats without executing or guessing a viewer", () => {
    expect(classifyFilePreview({ name: "report.pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(classifyFilePreview({ name: "sales.csv", mimeType: "text/csv" })).toBe("table");
    expect(classifyFilePreview({ name: "bundle.zip", mimeType: "application/zip" })).toBe("unsupported");
  });

  it("trusts a specific MIME type before a misleading extension", () => {
    expect(classifyFilePreview({ name: "photo.png", mimeType: "application/pdf" })).toBe("pdf");
    expect(classifyFilePreview({ name: "page.html", mimeType: "text/plain" })).toBe("text");
    expect(classifyFilePreview({ name: "clip.bin", mimeType: "video/mp4" })).toBe("video");
  });

  it("uses extensions only for absent or generic MIME types", () => {
    expect(classifyFilePreview({ name: "diagram.webp", mimeType: "application/octet-stream" })).toBe("image");
    expect(classifyFilePreview({ name: "README.MD" })).toBe("markdown");
    expect(classifyFilePreview({ name: "unknown.custom", mimeType: "application/octet-stream" })).toBe("unsupported");
  });

  it("validates home, project, worktree and artifact references", () => {
    expect(FileResourceRefSchema.parse({ kind: "home", path: "files/report.pdf" })).toEqual({
      kind: "home",
      path: "files/report.pdf",
    });
    expect(FileResourceRefSchema.parse({
      kind: "project",
      projectId: "project_demo",
      worktreeId: "wt_preview",
      path: "output/image.png",
    })).toMatchObject({ kind: "project", worktreeId: "wt_preview" });
    expect(FileResourceRefSchema.parse({
      kind: "artifact",
      chatId: "chat_demo",
      artifactId: "artifact_whale",
    })).toMatchObject({ kind: "artifact" });

    for (const resource of [
      { kind: "home", path: "../secret" },
      { kind: "project", projectId: "project_demo", path: "/etc/passwd" },
      { kind: "artifact", chatId: "chat_../bad", artifactId: "artifact_ok" },
    ]) {
      expect(FileResourceRefSchema.safeParse(resource).success).toBe(false);
    }
  });

  it("normalizes file links against their originating verified context", () => {
    expect(normalizeChatFileReference("reports/季度 报告.pdf:12", {
      root: "home",
      baseDirectory: "files",
    })).toEqual({ kind: "home", path: "files/reports/季度 报告.pdf" });
    expect(normalizeChatFileReference("charts%2Fwhale.png#L8", {
      root: "project",
      projectId: "project_demo",
      worktreeId: "wt_preview",
      baseDirectory: "generated",
    })).toEqual({
      kind: "project",
      projectId: "project_demo",
      worktreeId: "wt_preview",
      path: "generated/charts/whale.png",
    });
    expect(normalizeChatFileReference("file:///home/matrix/home/files/note.md", {
      root: "project",
      projectId: "project_demo",
      baseDirectory: "src",
    })).toEqual({ kind: "home", path: "files/note.md" });
  });

  it("rejects unverified paths, schemes, traversal and double encoding", () => {
    const context = { root: "home" as const, baseDirectory: "files" };
    for (const raw of [
      "../secret.txt",
      "%2e%2e%2Fsecret.txt",
      "%252e%252e%252Fsecret.txt",
      "sandbox:/tmp/generated.png",
      "file:///etc/passwd",
      "/absolute/path.png",
      "javascript:alert(1)",
      "https://example.com/image.png",
    ]) {
      expect(normalizeChatFileReference(raw, context)).toBeNull();
    }
  });

  it("bounds descriptors and keeps provider source private from the descriptor", () => {
    const descriptor = FilePreviewDescriptorSchema.parse({
      resource: { kind: "artifact", chatId: "chat_demo", artifactId: "artifact_whale" },
      name: "whale.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      kind: "image",
      version: "sha256:abc123",
      canDownload: true,
    });
    expect(descriptor).not.toHaveProperty("path");
    expect(FilePreviewDescriptorSchema.safeParse({ ...descriptor, sizeBytes: -1 }).success).toBe(false);

    expect(ChatArtifactProviderEventSchema.parse({
      providerItemId: "image_1",
      runId: "run_demo",
      source: { type: "run_file", path: "/verified/run/output/whale.png" },
      label: "whale.png",
      mimeType: "image/png",
    }).source).toMatchObject({ type: "run_file" });
  });
});
