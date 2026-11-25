import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatMessage } from "@matrix-os/contracts";
import { createChatElectronPreviewTransport } from "@desktop/main/chat-electron-preview/transport";
import type { AuthStatus } from "@desktop/main/auth/auth-service";

const chatId = "chat_original";
const runId = "run_original";
const projectId = "proj_matrix";
const worktreeId = "wt_abcdef012345";
const ownerId = "owner_a";
const origin = "https://matrix.test";
const turnId = "cturn_original";
const now = Date.parse("2026-11-17T03:05:00.000Z");
const timestamp = new Date(now - 60_000).toISOString();
const label = "YOUR SPACE TO BUILD";
const baseSha = "a".repeat(40);
const fileContent = "matching source in isolated Matrix worktree\n";
const sourcePath = "desktop/src/renderer/src/features/signin/SignIn.tsx";
const cwd = "worktrees/matrix-os/" + worktreeId;
const checkoutPath = "/home/matrix/home/" + cwd;
const originHead = checkoutPath + "\n" + baseSha + "\n";
const matchingStatus = " M " + sourcePath + "\0";
const pilotOutput = "?? .eng495-53d72ed9-0d31-4ed6-9cb4-fd150698377c/test.log\0";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = sha256(fileContent);
const marker = "MATRIX_ELECTRON_PREVIEW_V1 " + JSON.stringify({ baseSha, sourceSha256, label, mainChecksPassed: true });
const selection = { instanceId: "codex_default", model: "gpt-6.1-sol" };
const executionRoot = { kind: "worktree", projectId, worktreeId };
function fixture(parts: CanonicalChatMessage["parts"] = [{ type: "text", text: marker }]) {
  return {
    record: {
      projectId,
      chat: {
        id: chatId, ownerScope: { type: "personal", ownerId }, lifecycle: "active",
        attention: "none", title: "Original", revision: 5, messageCount: 1,
        currentSelection: selection, createdAt: timestamp, updatedAt: timestamp,
      },
    },
    messages: [{
      id: "msg_original", role: "assistant", state: "committed", chatId,
      seq: 1, runId, turnId, parts, createdAt: timestamp,
    }],
    runs: [{
      id: runId, chatId, turnId, attempt: 1, driverKind: "codex", instanceId: selection.instanceId,
      selection, interactionMode: "default", permissionMode: "full_access", executionRoot,
      executionRootFingerprint: "b".repeat(64), status: "completed", outcome: "completed",
      historyBoundarySeq: 0, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, completedAt: timestamp,
      capabilitySnapshot: {
        revision: "catalog", rootChat: true, attachments: ["image"], resources: [], tools: [],
        approvals: true, userInput: true, resume: true, cancellation: true, worktrees: "optional",
        interactionModes: ["default"], permissionModes: ["full_access", "supervised"],
      },
    }],
    turns: [],
    activities: [],
  };
}

const png = Buffer.from("89504e470d0a1a0a010203", "hex");
function mockTransport(parts?: CanonicalChatMessage["parts"]) {
  let authStatus: AuthStatus = { signedIn: true, userId: ownerId, handle: "owner", runtimeSlot: "primary", platformHost: origin, authGeneration: 4 };
  const auth = { getStatus: () => authStatus, getToken: () => authStatus.signedIn ? "test-auth" : null, getGatewayOrigin: () => origin };
  const detail = fixture(parts);
  const source = {
    metadata: { path: sourcePath, kind: "file", sizeBytes: Buffer.byteLength(fileContent), etag: sourceSha256, updatedAt: timestamp },
    content: fileContent, encoding: "utf8", truncated: false, limitBytes: 65_536,
  };
  const inventory = [{ id: worktreeId, path: checkoutPath, projectSlug: "matrix-os" }];
  let gitHead = originHead;
  let gitStatus = matchingStatus;
  let uploadStatus = 200;
  let uploadedBytes = png;
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/chats/" + chatId) return Response.json(detail);
    if (url.pathname === "/api/projects/matrix-os") return Response.json({ project: { id: projectId, slug: "matrix-os" } });
    if (url.pathname === "/api/projects/matrix-os/worktrees") return Response.json({ worktrees: inventory });
    if (url.pathname === "/api/terminal/run") {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ cwd, timeoutMs: 5000 });
      expect(request.command.slice(0, 5)).toEqual(["/usr/bin/git", "--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager"]);
      const stdout = request.command.includes("rev-parse") ? gitHead : gitStatus;
      return Response.json({ stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 10 });
    }
    if (url.pathname === "/api/coding-agents/files/read") return Response.json(source);
    if (url.pathname === "/api/files/blob") {
      if (init?.method === "PUT") {
        return Response.json({ ok: true, path: url.searchParams.get("path"), size: png.length }, { status: uploadStatus });
      }
      return new Response(new Uint8Array(uploadedBytes), { headers: { "content-type": "image/png" } });
    }
    if (url.pathname === "/api/chats/" + chatId + "/turns") {
      const request = JSON.parse(String(init?.body));
      const returnTurnId = "cturn_return";
      const returnedMessageId = "msg_return";
      return Response.json({
        record: detail.record,
        message: { id: returnedMessageId, chatId, role: "user", state: "committed", seq: 2,
          parts: request.parts, turnId: returnTurnId, createdAt: timestamp },
        turn: { id: returnTurnId, chatId, clientRequestId: request.clientRequestId, inputMessageId: returnedMessageId,
          baseMessageSeq: 1, status: "accepted", createdAt: timestamp, updatedAt: timestamp },
        run: { ...detail.runs[0], id: "run_return", turnId: returnTurnId, selection: request.selection },
        admission: "accepted",
      }, { status: 202 });
    }
    throw new Error("Unexpected request " + url.pathname);
  });
  return { detail, source, inventory, fetchFn,
    setGit: (head: string, status: string) => { gitHead = head; gitStatus = status; },
    service: createChatElectronPreviewTransport(auth, { fetchFn, now: () => now }),
    changeSession: () => { authStatus = { ...authStatus, authGeneration: 5 }; },
    existingUpload: (bytes: Buffer) => { uploadStatus = 409; uploadedBytes = bytes; },
  };
}

function resultWrites(fetchFn: ReturnType<typeof mockTransport>["fetchFn"]) {
  return fetchFn.mock.calls.filter(([input, init]) => new URL(String(input)).pathname !== "/api/terminal/run"
    && (init?.method === "PUT" || init?.method === "POST"));
}

describe("authenticated Chat Electron preview transport", () => {
  it("binds a fresh assistant request to the existing owner and exact worktree bytes", async () => {
    const { service, fetchFn } = mockTransport();
    const request = await service.read({ chatId, runId });
    expect(request).toMatchObject({
      chatId, runId, projectId, worktreeId, label, baseSha, sourceSha256, expiresAt: now + 9 * 60_000,
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(service.isCurrent(request!)).toBe(true);
    expect(fetchFn.mock.calls).toHaveLength(6);
    const [target, options] = fetchFn.mock.calls.at(-1)!;
    const url = new URL(String(target));
    expect(url.pathname).toBe("/api/coding-agents/files/read");
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: "matrix-os", worktreeId, path: sourcePath });
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer test-auth");
    expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    expect(JSON.stringify(request)).not.toContain("test-auth");
  });

  it("reads a completed request that straddles the recovered assistant text boundary", async () => {
    const output = `${"a".repeat(3985)}\n${marker}`;
    const { service } = mockTransport([
      { type: "text", text: output.slice(0, 4000) },
      { type: "text", text: output.slice(4000) },
    ]);

    await expect(service.read({ chatId, runId })).resolves.toMatchObject({ chatId, runId, worktreeId, sourceSha256, label });
  });

  it.each([
    ["an open fence", [{ type: "text", text: "```json\n" }, { type: "text", text: marker + "\n```" }]],
    ["a non-text boundary", [
      { type: "text", text: marker.slice(0, 14) },
      { type: "status", tone: "info", label: "Source checked" },
      { type: "text", text: marker.slice(14) },
    ]],
  ] satisfies [string, CanonicalChatMessage["parts"]][])("rejects a marker inside %s", async (_reason, parts) => {
    const { service, fetchFn } = mockTransport(parts);

    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it.each([
    ["wrong owner", (detail: ReturnType<typeof fixture>) => { detail.record.chat.ownerScope.ownerId = "other"; }],
    ["user-authored marker", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.role = "user"; }],
    ["duplicate markers", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.parts.push({ type: "text", text: `\n${marker}` }); }],
    ["wrong project", (detail: ReturnType<typeof fixture>) => { detail.record.projectId = "proj_other"; }],
    ["expired completion", (detail: ReturnType<typeof fixture>) => { detail.runs[0]!.completedAt = new Date(now - 11 * 60_000).toISOString(); }],
  ])("rejects %s before reading source or writing", async (_reason, tamper) => {
    const { service, detail, fetchFn } = mockTransport();
    tamper(detail);
    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it("rejects stale source and revoked session and never sends a screenshot", async () => {
    const first = mockTransport();
    first.source.content = "another patch";
    await expect(first.service.read({ chatId, runId })).resolves.toBeNull();
    const { service, fetchFn, changeSession } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    changeSession();
    expect(service.isCurrent(request)).toBe(false);
    await expect(service.returnResult(request, { png, testSummary: "10 tests passed" })).rejects.toThrow();
    expect(resultWrites(fetchFn)).toHaveLength(0);
  });

  it("accepts only the isolated worktree HEAD and the one unstaged source edit", async () => {
    const { service, setGit, inventory, fetchFn } = mockTransport();
    setGit(checkoutPath + "\n" + "c".repeat(40) + "\n", matchingStatus);
    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    setGit(originHead, matchingStatus + " M another.ts\0");
    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    setGit(originHead, matchingStatus + "?? another.ts\0");
    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    setGit(originHead, matchingStatus + pilotOutput);
    await expect(service.read({ chatId, runId })).resolves.toMatchObject({ worktreeId, sourceSha256 });
    inventory[0]!.path = "/home/matrix/home/projects/matrix-os";
    await expect(service.read({ chatId, runId })).resolves.toBeNull();
    expect(resultWrites(fetchFn)).toHaveLength(0);
  });

  it("revalidates the cloud worktree before upload following local build", async () => {
    const { service, setGit, fetchFn } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    setGit(originHead, matchingStatus + "?? another.ts\0");
    await expect(service.returnResult(request, { png, testSummary: "10 tests passed" })).rejects.toThrow();
    expect(resultWrites(fetchFn)).toHaveLength(0);
  });

  it("posts the image and bounded test summary to the originating Chat worktree", async () => {
    const { service, fetchFn } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    await service.returnResult(request, { png, testSummary: "10 tests passed" });
    const writes = resultWrites(fetchFn);
    expect(writes).toHaveLength(2);
    const upload = new URL(String(writes[0]![0]));
    const path = upload.searchParams.get("path");
    expect(path).toMatch(/^temporary\/desktop-chat\/electron-preview-[a-f0-9]{64}\.png$/);
    expect(upload.searchParams.has("force")).toBe(false);
    const result = JSON.parse(String(writes[1]![1]?.body));
    expect(new URL(String(writes[1]![0])).pathname).toBe("/api/chats/" + chatId + "/turns");
    expect(result).toMatchObject({
      clientRequestId: expect.stringMatching(/^req_electron_preview_[a-f0-9]{64}$/),
      baseRevision: 5, executionRoot, selection, permissionMode: "supervised",
      parts: [
        { type: "text", text: expect.stringContaining("10 tests passed") },
        { type: "attachment_reference", ownerReference: path, mimeType: "image/png", sizeBytes: png.length },
      ],
    });
  });

  it("reports an approved build failure to the original Chat without an attachment", async () => {
    const { service, fetchFn } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    await service.returnResult(request, { error: "build-failed" });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    const postBody = JSON.parse(String(resultWrites(fetchFn)[0]![1]?.body));
    expect(postBody.parts).toEqual([{ type: "text", text: expect.stringContaining("failed") }]);
  });

  it("refuses an existing screenshot at that path when its bytes differ", async () => {
    const { service, fetchFn, existingUpload } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    existingUpload(Buffer.from("different"));
    await expect(service.returnResult(request, { png, testSummary: "10 tests passed" })).rejects.toThrow();
    expect(resultWrites(fetchFn).some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
