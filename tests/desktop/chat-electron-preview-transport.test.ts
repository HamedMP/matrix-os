import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatMessage } from "@matrix-os/contracts";
import { createChatMacTerminalService } from "@desktop/main/chat-mac-terminal/service";
import {
  createChatElectronPreviewTransport,
  MacTerminalDeliveryRejectedError,
} from "@desktop/main/chat-electron-preview/transport";
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
const previewResult = { png, testSummary: "10 tests passed" };
const activeRun = { runId: "run_concurrent", turnId: "cturn_concurrent", status: "running" };
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
  let busyReads = 0;
  let nextTurnConflict: string | undefined;
  let storeResult = false;
  let savedReceipt: { message: unknown; turn: unknown; run: unknown } | undefined;
  let returnedRunChatId = chatId;
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/chats/" + chatId) {
      const current = savedReceipt ? { ...detail, messages: [...detail.messages, savedReceipt.message],
        runs: [...detail.runs, savedReceipt.run], turns: [...detail.turns, savedReceipt.turn] } : detail;
      if (busyReads > 0) {
        busyReads--;
        return Response.json({ ...current, record: { ...current.record, activeRun } });
      }
      return Response.json(current);
    }
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
      if (nextTurnConflict) {
        const code = nextTurnConflict;
        nextTurnConflict = undefined;
        if (code === "chat_conflict") detail.record.chat.revision++;
        return Response.json({ error: { code, safeMessage: "Chat changed.", retryable: true } }, { status: 409 });
      }
      const returnTurnId = "cturn_return";
      const returnedMessageId = "msg_return";
      const receipt = {
        record: detail.record,
        message: { id: returnedMessageId, chatId, role: "user", state: "committed", seq: 2,
          parts: request.parts, turnId: returnTurnId, createdAt: timestamp },
        turn: { id: returnTurnId, chatId, clientRequestId: request.clientRequestId, inputMessageId: returnedMessageId,
          baseMessageSeq: 1, status: "accepted", createdAt: timestamp, updatedAt: timestamp },
        run: { ...detail.runs[0], id: "run_return", chatId: returnedRunChatId, turnId: returnTurnId, selection: request.selection },
        admission: "accepted",
      };
      if (storeResult) savedReceipt = receipt;
      return Response.json(receipt, { status: 202 });
    }
    throw new Error("Unexpected request " + url.pathname);
  });
  return { detail, source, inventory, fetchFn,
    setGit: (head: string, status: string) => { gitHead = head; gitStatus = status; },
    setBusyReads: (count: number) => { busyReads = count; },
    rejectNextTurn: (code: string) => { nextTurnConflict = code; },
    service: createChatElectronPreviewTransport(auth, { fetchFn, now: () => now }),
    changeSession: () => { authStatus = { ...authStatus, authGeneration: 5 }; },
    existingUpload: (bytes: Buffer) => { uploadStatus = 409; uploadedBytes = bytes; },
    storeResult: () => { storeResult = true; },
    misrouteResult: () => { returnedRunChatId = "chat_wrong"; },
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

  it("discovers a background preview only for the approved target and binds the exact operation", async () => {
    const { detail, service, fetchFn } = mockTransport();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    const targetId = "d5739cf6-cb60-4b79-99a1-d95c23949a5c";
    const grant = { targetId, approvedAt: now - 120_000 };
    const signal = new AbortController().signal;
    const ref = { chatId, runId };
    const binding = { context, grant, signal };
    detail.messages[0]!.parts[0]!.text = "MATRIX_ELECTRON_PREVIEW_V1 " + JSON.stringify({
      baseSha, sourceSha256, label, mainChecksPassed: true, operation: "verify-sign-in-recovery",
      backgroundTargetId: targetId,
    });

    await expect(service.read(ref)).resolves.toBeNull();
    await expect(service.readBackgroundPreviewTarget(context, grant, signal)).resolves.toEqual(ref);
    await expect(service.read(ref, binding)).resolves.toMatchObject({
      ...ref, worktreeId, operation: "verify-sign-in-recovery", backgroundTargetId: targetId,
    });
    fetchFn.mockClear();
    await expect(service.read(ref, { ...binding, context: { ...context } })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(service.readBackgroundPreviewTarget(context, { ...grant, approvedAt: now }, signal)).resolves.toBeNull();
    await expect(service.read(ref, { ...binding, grant: {
      ...grant, targetId: "ea1aa370-5a08-4f21-9e05-69f8fc547c7e",
    } })).resolves.toBeNull();
    expect(resultWrites(fetchFn)).toEqual([]);
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

  it("delivers one screenshot when the original Chat becomes free after a concurrent run", async () => {
    const { service, fetchFn, setBusyReads } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    setBusyReads(1);

    await expect(service.returnResult(request, previewResult)).resolves.toBeUndefined();
    expect(resultWrites(fetchFn).map(([, init]) => init?.method)).toEqual(["PUT", "POST"]);
  });

  it.each(["chat_busy", "chat_conflict"])("preserves the upload and request identity after admission reports %s", async code => {
    const { service, fetchFn, rejectNextTurn } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    rejectNextTurn(code);

    await expect(service.returnResult(request, previewResult)).resolves.toBeUndefined();
    const [upload, first, retried] = resultWrites(fetchFn);
    expect(resultWrites(fetchFn).map(([, init]) => init?.method)).toEqual(["PUT", "POST", "POST"]);
    const firstBody = JSON.parse(String(first?.[1]?.body));
    const retriedBody = JSON.parse(String(retried?.[1]?.body));
    expect(retriedBody).toEqual({
      ...firstBody,
      baseRevision: code === "chat_conflict" ? 6 : 5,
    });
    expect(retriedBody.parts[1]).toMatchObject({
      ownerReference: new URL(String(upload?.[0])).searchParams.get("path"),
    });
  });

  it("cancels a pending return without uploading or posting after revocation", async () => {
    const { service, fetchFn, setBusyReads } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    setBusyReads(1);
    const controller = new AbortController();
    const revoked = new Error("Preview revoked");
    const returning = service.returnResult(request, previewResult, controller.signal).catch((error: unknown) => error);

    await vi.waitFor(() => expect(fetchFn.mock.calls).toHaveLength(7));
    controller.abort(revoked);

    const error = await returning;
    expect(error instanceof Error ? error.cause ?? error : error).toBe(revoked);
    expect(resultWrites(fetchFn)).toHaveLength(0);
    expect(fetchFn.mock.calls).toHaveLength(7);
  });

  it("does not retry unrelated admission conflicts", async () => {
    const { service, fetchFn, rejectNextTurn } = mockTransport();
    const request = (await service.read({ chatId, runId }))!;
    rejectNextTurn("provider_instance_locked");

    await expect(service.returnResult(request, previewResult)).rejects.toThrow("Preview result could not be posted");
    expect(resultWrites(fetchFn).map(([, init]) => init?.method)).toEqual(["PUT", "POST"]);
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

describe("authenticated Chat Mac terminal probe transport", () => {
  const targetId = "d5739cf6-cb60-4b79-99a1-d95c23949a5c";
  const terminalMarker = 'MATRIX_MAC_TERMINAL_V1 {"targetId":"' + targetId + '","action":"uname"}';
  const ref = { chatId, runId };
  const grant = { targetId, approvedAt: now - 120_000 };

  function terminalFixture() {
    const mock = mockTransport();
    mock.detail.messages[0]!.parts[0]!.text = terminalMarker;
    return mock;
  }

  it("binds the selected latest Chat worktree and returns the fixed result to exactly that Chat", async () => {
    const { service, fetchFn } = terminalFixture();
    const context = await service.readTerminalContext({ chatId, worktreeId });
    expect(context).toMatchObject({ chatId, projectId, worktreeId, scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(service.isTerminalContextCurrent(context!)).toBe(true);
    const request = await service.readTerminalRequest(ref);
    expect(request).toMatchObject({
      ...context, runId, targetId, action: "uname", expiresAt: now + 4 * 60_000,
    });
    expect(service.isTerminalRequestCurrent(request!)).toBe(true);
    expect(JSON.stringify(request)).not.toContain("test-auth");
    expect(service.isTerminalRequestCurrent({ ...request! })).toBe(false);

    await service.returnTerminalResult(request!, { terminalId: targetId, output: "Darwin" });
    const writes = resultWrites(fetchFn);
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/chats/" + chatId + "/turns");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-auth");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      clientRequestId: expect.stringMatching(/^req_mac_terminal_[a-f0-9]{64}$/), baseRevision: 5,
      executionRoot, selection, interactionMode: "default", permissionMode: "supervised",
      parts: [{ type: "text", text: expect.stringContaining("Darwin") }],
    });
    expect(fetchFn.mock.calls.some(([input]) => new URL(String(input)).pathname === "/api/terminal/run")).toBe(false);
  });

  it.each([
    ["foreign owner", (detail: ReturnType<typeof fixture>) => { detail.record.chat.ownerScope.ownerId = "other"; }],
    ["user marker", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.role = "user"; }],
    ["unrelated turn", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.turnId = "cturn_other"; }],
    ["code fence", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.parts[0]!.text = "\`\`\`\n" + terminalMarker + "\n\`\`\`"; }],
    ["extra command arguments", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.parts[0]!.text = terminalMarker.replace("}", ',"args":["-a"]}'); }],
    ["multiple requests", (detail: ReturnType<typeof fixture>) => { detail.messages[0]!.parts[0]!.text += "\n" + terminalMarker; }],
    ["expired completion", (detail: ReturnType<typeof fixture>) => { detail.runs[0]!.completedAt = new Date(now - 5 * 60_000).toISOString(); }],
    ["future completion", (detail: ReturnType<typeof fixture>) => { detail.runs[0]!.completedAt = new Date(now + 1).toISOString(); }],
    ["superseded run", (detail: ReturnType<typeof fixture>) => {
      detail.runs.push({ ...detail.runs[0]!, id: "run_newer", completedAt: new Date(now - 1).toISOString() });
    }],
  ] as const)("rejects a %s", async (_name, change) => {
    const { service, detail, fetchFn } = terminalFixture();
    change(detail);
    await expect(service.readTerminalRequest(ref)).resolves.toBeNull();
    expect(resultWrites(fetchFn)).toEqual([]);
  });

  it("reads a terminal request spanning the 4,000-character recovery boundary", async () => {
    const output = ["a".repeat(3_985), terminalMarker].join("\n");
    const { service } = mockTransport([
      { type: "text", text: output.slice(0, 4_000) },
      { type: "text", text: output.slice(4_000) },
    ]);

    await expect(service.readTerminalRequest(ref)).resolves.toMatchObject({
      ...ref, worktreeId, targetId, action: "uname",
    });
  });

  const splitFenceOutput = ["a".repeat(3_998), "~~~", terminalMarker, "~~~"].join("\n");
  const splitDuplicateOutput = ["a".repeat(3_985), terminalMarker, terminalMarker].join("\n");
  it.each([
    ["an opener split inside a code fence", [
      { type: "text", text: splitFenceOutput.slice(0, 4_000) },
      { type: "text", text: splitFenceOutput.slice(4_000) },
    ]],
    ["a non-text part interrupting the marker", [
      { type: "text", text: terminalMarker.slice(0, 14) },
      { type: "status", tone: "info", label: "Worktree checked" },
      { type: "text", text: terminalMarker.slice(14) },
    ]],
    ["a duplicate request split across text parts", [
      { type: "text", text: splitDuplicateOutput.slice(0, 4_000) },
      { type: "text", text: splitDuplicateOutput.slice(4_000) },
    ]],
  ] satisfies [string, CanonicalChatMessage["parts"]][])("rejects %s", async (_reason, parts) => {
    const { service, fetchFn } = mockTransport(parts);

    await expect(service.readTerminalRequest(ref)).resolves.toBeNull();
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it("does not post the one-time terminal output when its grant is canceled before Chat admission", async () => {
    const { detail, service: transport, fetchFn } = terminalFixture();
    const finalRead = Promise.withResolvers<void>();
    const resumeRead = Promise.withResolvers<void>();
    const reply = fetchFn.getMockImplementation()!;
    let terminalRan = false;
    fetchFn.mockImplementation(async (input, init) => {
      if (terminalRan && new URL(String(input)).pathname === `/api/chats/${chatId}`) {
        finalRead.resolve();
        await resumeRead.promise;
      }
      return reply(input, init);
    });
    const terminal = {
      id: targetId,
      async run(): Promise<"Darwin"> {
        terminalRan = true;
        return "Darwin";
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const service = createChatMacTerminalService({
      ...transport,
      enabled: true,
      approve: async () => true,
      prepareTerminal: async () => terminal,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const grant = await service.prepare({ chatId, worktreeId });
      if (grant.status !== "ready") throw new Error(`expected a ready terminal, got ${grant.status}`);
      detail.messages[0]!.parts[0]!.text = terminalMarker.replace(targetId, grant.targetId);

      const running = service.run(ref);
      await Promise.race([finalRead.promise, running.then(result => {
        throw new Error(`expected an in-flight Chat read, got ${result.status}`);
      })]);
      const stopped = service.cancel(chatId);
      resumeRead.resolve();
      await expect(stopped).resolves.toBe(true);

      const result = await running;
      expect(resultWrites(fetchFn)).toEqual([]);
      expect(result).toEqual({ status: "unavailable" });
      expect(terminal.dispose).toHaveBeenCalledTimes(1);
    } finally {
      resumeRead.resolve();
      await service.cancelAll();
      clock.mockRestore();
    }
  });

  it("uses the same canonical result turn on retries", async () => {
    const { service, storeResult, fetchFn } = terminalFixture();
    storeResult();
    const request = (await service.readTerminalRequest(ref))!;
    const result = { terminalId: targetId, output: "Darwin" as const };

    await service.returnTerminalResult(request, result);
    await service.returnTerminalResult(request, result);

    expect(resultWrites(fetchFn)).toHaveLength(1);
  });

  it("rejects a return receipt for a run belonging to another Chat", async () => {
    const { service, misrouteResult } = terminalFixture();
    const request = (await service.readTerminalRequest(ref))!;
    misrouteResult();

    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" }))
      .rejects.toThrow("Mac terminal result receipt mismatch");
  });

  it.each([
    ["newer completed run", (detail: ReturnType<typeof fixture>) => {
      detail.runs.push({ ...detail.runs[0]!, id: "run_newer", completedAt: new Date(now - 1).toISOString() });
    }],
    ["changed worktree", (detail: ReturnType<typeof fixture>) => {
      detail.runs[0]!.executionRoot = { ...executionRoot, worktreeId: "wt_abcdef012346" };
    }],
  ] as const)("permanently rejects delivery after a %s", async (_name, change) => {
    const { service, detail, fetchFn } = terminalFixture();
    const request = (await service.readTerminalRequest(ref))!;
    change(detail);

    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" }))
      .rejects.toBeInstanceOf(MacTerminalDeliveryRejectedError);
    expect(resultWrites(fetchFn)).toEqual([]);
  });

  it("can deliver the same result once an active-only interruption settles", async () => {
    const { service, detail, fetchFn } = terminalFixture();
    const request = (await service.readTerminalRequest(ref))!;
    const result = { terminalId: targetId, output: "Darwin" as const };
    Object.assign(detail.record, { activeRun: { runId: "run_newer", turnId: "cturn_newer", status: "running" } });

    const waiting = await service.returnTerminalResult(request, result).catch((error: unknown) => error);
    expect(waiting).toBeInstanceOf(Error);
    expect(waiting).not.toBeInstanceOf(MacTerminalDeliveryRejectedError);
    expect(resultWrites(fetchFn)).toEqual([]);

    Reflect.deleteProperty(detail.record, "activeRun");
    await service.returnTerminalResult(request, result);
    expect(resultWrites(fetchFn)).toHaveLength(1);
  });

  it("rejects a mismatched worktree and a replaced session without returning a result", async () => {
    const { service, changeSession, fetchFn } = terminalFixture();
    await expect(service.readTerminalContext({ chatId, worktreeId: "wt_abcdef012346" })).resolves.toBeNull();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    const request = (await service.readTerminalRequest(ref))!;
    changeSession();

    expect(service.isTerminalContextCurrent(context)).toBe(false);
    expect(service.isTerminalRequestCurrent(request)).toBe(false);
    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" })).rejects.toThrow();
    expect(resultWrites(fetchFn)).toEqual([]);
  });

  it("discovers the current request from the approved Chat without a renderer-supplied run ID", async () => {
    const { service, fetchFn } = terminalFixture();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    fetchFn.mockClear();

    const request = await service.readBackgroundTerminalRequest(context, grant, new AbortController().signal);
    expect(request).toMatchObject({ ...context, ...ref, targetId, action: "uname" });
    expect(service.isTerminalRequestCurrent(request!)).toBe(true);
    expect(fetchFn.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/chats/" + chatId,
      "/api/projects/matrix-os",
      "/api/projects/matrix-os/worktrees",
    ]);
    expect(resultWrites(fetchFn)).toEqual([]);
  });

  it("returns the fixed multi-command check only for a background request and only once", async () => {
    const { service, detail, storeResult, fetchFn } = terminalFixture();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    detail.messages[0]!.parts[0]!.text = terminalMarker.replace("uname", "system-checks");
    await expect(service.readTerminalRequest(ref)).resolves.toBeNull();
    const request = (await service.readBackgroundTerminalRequest(context, grant, new AbortController().signal))!;
    expect(request.action).toBe("system-checks");
    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" })).rejects.toThrow();
    storeResult();
    const result = { terminalId: targetId, output: { kernel: "Darwin", architecture: "arm64", macOSVersion: "15.7.2" } } as const;
    await service.returnTerminalResult(request, result);
    await service.returnTerminalResult(request, result);
    const writes = resultWrites(fetchFn);
    expect(writes).toHaveLength(1);
    const text = JSON.parse(String(writes[0]![1]?.body)).parts[0].text;
    expect(text).toContain("/usr/bin/uname -s: Darwin (exit 0)");
    expect(text).toContain("/usr/bin/uname -m: arm64 (exit 0)");
    expect(text).toContain("/usr/bin/sw_vers -productVersion: 15.7.2 (exit 0)");
  });

  it.each(["another target", "another owner", "another Chat", "another worktree", "a run completed before approval"] as const)(
    "ignores %s before reading any worktree inventory", async (mismatch) => {
      const { service, detail, fetchFn } = terminalFixture();
      const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
      if (mismatch === "another target") {
        detail.messages[0]!.parts[0]!.text = terminalMarker.replace(targetId, "ea1aa370-5a08-4f21-9e05-69f8fc547c7e");
      } else if (mismatch === "another owner") {
        detail.record.chat.ownerScope.ownerId = "other";
      } else if (mismatch === "another Chat") {
        detail.record.chat.id = "chat_other";
      } else if (mismatch === "another worktree") {
        detail.runs[0]!.executionRoot = { ...executionRoot, worktreeId: "wt_abcdef012346" };
      } else {
        detail.runs[0]!.completedAt = new Date(grant.approvedAt - 1).toISOString();
      }
      fetchFn.mockClear();

      await expect(service.readBackgroundTerminalRequest(context, grant, new AbortController().signal)).resolves.toBeNull();
      expect(fetchFn.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/chats/" + chatId]);
      expect(resultWrites(fetchFn)).toEqual([]);
    },
  );

  it("rejects a copied context or changed account generation without polling", async () => {
    const { service, changeSession, fetchFn } = terminalFixture();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    const signal = new AbortController().signal;
    fetchFn.mockClear();

    await expect(service.readBackgroundTerminalRequest({ ...context }, grant, signal)).resolves.toBeNull();
    changeSession();
    await expect(service.readBackgroundTerminalRequest(context, grant, signal)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("propagates a stop to an in-flight poll and ignores the late response", async () => {
    const { service, detail, fetchFn } = terminalFixture();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    const controller = new AbortController();
    fetchFn.mockClear();
    fetchFn.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json(detail);
    });

    await expect(service.readBackgroundTerminalRequest(context, grant, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not contact the Gateway when result delivery has already been stopped", async () => {
    const { service, fetchFn } = terminalFixture();
    const request = (await service.readTerminalRequest(ref))!;
    fetchFn.mockClear();

    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" }, AbortSignal.abort()))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("propagates a stop while posting the result", async () => {
    const { service, fetchFn } = terminalFixture();
    const request = (await service.readTerminalRequest(ref))!;
    const controller = new AbortController();
    const transportFetch = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        controller.abort();
        expect(init.signal?.aborted).toBe(true);
      }
      return transportFetch(input, init);
    });

    await expect(service.returnTerminalResult(request, { terminalId: targetId, output: "Darwin" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(resultWrites(fetchFn)).toHaveLength(1);
  });

  it("recovers a background receipt after losing the response to an accepted result", async () => {
    const { service, fetchFn, storeResult } = terminalFixture();
    const context = (await service.readTerminalContext({ chatId, worktreeId }))!;
    const signal = new AbortController().signal;
    const request = (await service.readBackgroundTerminalRequest(context, grant, signal))!;
    const result = { terminalId: targetId, output: "Darwin" as const };
    const transportFetch = fetchFn.getMockImplementation()!;
    storeResult();
    fetchFn.mockImplementation(async (input, init) => {
      const reply = await transportFetch(input, init);
      if (init?.method === "POST") throw new Error("connection dropped after admission");
      return reply;
    });

    await expect(service.returnTerminalResult(request, result, signal)).rejects.toThrow("connection dropped");
    await expect(service.returnTerminalResult(request, result, signal)).resolves.toBeUndefined();
    expect(resultWrites(fetchFn)).toHaveLength(1);
  });
});
