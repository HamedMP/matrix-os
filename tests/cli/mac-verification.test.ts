import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAC_VERIFICATION_SOURCE_BY_RECIPE, macVerificationTerminalIntentPath,
} from "@matrix-os/contracts/mac-verification-terminal";
import { queueMacVerification } from "../../packages/sync-client/src/cli/mac-verification-client.js";

const chatId = "chat_original";
const worktreeId = "wt_abcdef012345";
const projectId = "proj_matrix";
const runId = "run_latest";
const ownerId = "user_owner";
const stamp = (age = 10) => new Date(Date.now() - age).toISOString();
const source = "a small unpublished candidate\n";
const gatewayUrl = "https://matrix.example/vm/test-computer/?runtime=primary&unused=value";
let checkout: string;
let baseSha: string;

beforeAll(async () => {
  checkout = await mkdtemp(join(tmpdir(), "matrix-mac-verify-test-"));
  for (const path of Object.values(MAC_VERIFICATION_SOURCE_BY_RECIPE)) {
    const full = join(checkout, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, source);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 5000 });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Matrix CLI test", "-c", "user.email=matrix-test@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  baseSha = git("rev-parse", "HEAD").trim();
});
afterAll(async () => { await rm(checkout, { recursive: true, force: true }); });

function resultRun(options: {
  id?: string; age?: number; project?: string; worktree?: string; driver?: string;
  status?: "completed" | "failed"; chat?: string;
} = {}) {
  const completedAt = stamp(options.age);
  const status = options.status ?? "completed";
  return { id: options.id ?? runId, chatId: options.chat ?? chatId, turnId: "cturn_original", attempt: 1,
    driverKind: options.driver ?? "codex", instanceId: "inst_codex", selection: { instanceId: "inst_codex", model: "fixture" },
    interactionMode: "default", permissionMode: "supervised", executionRoot: {
      kind: "worktree", projectId: options.project ?? projectId, worktreeId: options.worktree ?? worktreeId,
    }, executionRootFingerprint: "b".repeat(64), status, outcome: status, historyBoundarySeq: 0,
    createdAt: completedAt, updatedAt: completedAt, startedAt: completedAt, completedAt,
    capabilitySnapshot: { revision: "catalog", rootChat: true, attachments: ["image"], resources: [], tools: [],
      approvals: true, userInput: true, resume: true, cancellation: true, worktrees: "optional",
      interactionModes: ["default"], permissionModes: ["supervised"] } };
}

function detail(runs = [resultRun()]) {
  return { record: { projectId, chat: { id: chatId, lifecycle: "active", ownerScope: { type: "personal", ownerId },
    attention: "none", title: "Original Chat", revision: 0, messageCount: 0, createdAt: stamp(), updatedAt: stamp(),
  } }, messages: [], turns: [], runs, activities: [] };
}

function fixture(chatResponse = detail(), conflict?: string) {
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === `/vm/test-computer/api/chats/${chatId}`) return Response.json(chatResponse);
    if (url.pathname !== "/vm/test-computer/api/files/blob") throw new Error("unexpected fixture URL");
    if (init?.method === "PUT") return conflict === undefined
      ? Response.json({ ok: true, path: url.searchParams.get("path"), size: Buffer.byteLength(String(init?.body)) })
      : new Response(null, { status: 409 });
    return new Response(conflict);
  });
  const queue = (options: { recipe?: "sign-in" | "files-trash"; sourceCwd?: string; userId?: string } = {}) =>
    queueMacVerification({ gatewayUrl, token: "test-bearer", ownerId: options.userId ?? ownerId,
      chatId, worktreeId, recipe: options.recipe ?? "files-trash", cwd: options.sourceCwd ?? checkout, fetchFn });
  return { fetchFn, queue };
}

async function expectedBody(recipe = "files-trash") {
  return JSON.stringify({ version: 1, chatId, runId, projectId, worktreeId, recipe, baseSha,
    sourceSha256: createHash("sha256").update(source).digest("hex") });
}

describe("matrix mac verify terminal request", () => {
  it("queues the exact candidate for the latest completed worktree run and preserves the selected runtime", async () => {
    const { fetchFn, queue } = fixture(detail([resultRun({ id: "run_previous", age: 1000 }), resultRun()]));
    const result = await queue({ sourceCwd: join(checkout, "desktop") });
    expect(result).toEqual({ status: "queued", chatId, runId, worktreeId, recipe: "files-trash" });
    const [read, upload] = fetchFn.mock.calls;
    expect(new URL(String(read?.[0])).searchParams.get("messageVersion")).toBe("2");
    const uploadUrl = new URL(String(upload?.[0]));
    expect(uploadUrl.searchParams.get("runtime")).toBe("primary");
    expect(uploadUrl.searchParams.get("path")).toBe(await macVerificationTerminalIntentPath(chatId, runId));
    expect(uploadUrl.searchParams.has("force")).toBe(false);
    expect(upload?.[1]).toMatchObject({ method: "PUT", redirect: "error", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ authorization: "Bearer test-bearer" }), body: await expectedBody() });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("supports leading global flags on the published matrix executable", async () => {
    let intent: unknown;
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith(`/vm/test-computer/api/chats/${chatId}?`)) {
        response.end(JSON.stringify(detail()));
      } else if (request.url?.startsWith("/vm/test-computer/api/files/blob?") && request.method === "PUT") {
        const body: Buffer[] = [];
        for await (const bytes of request) body.push(Buffer.from(bytes));
        const bytes = Buffer.concat(body);
        intent = JSON.parse(bytes.toString());
        const path = new URL(request.url, "http://127.0.0.1").searchParams.get("path");
        response.end(JSON.stringify({ ok: true, path, size: bytes.length }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test Gateway address missing");
    try {
      const bin = resolve(import.meta.dirname, "../../packages/sync-client/bin/matrix.mjs");
      const { stdout } = await promisify(execFile)(process.execPath, [
        bin, "--json", "--gateway", `http://127.0.0.1:${address.port}/vm/test-computer`, "--token", "fixture",
        "mac", "verify", "--chat", chatId, "--worktree", worktreeId, "--recipe", "files-trash",
      ], { cwd: checkout, timeout: 10_000, env: { ...process.env, MATRIX_NO_TELEMETRY: "1" } });
      expect(JSON.parse(stdout)).toEqual({ v: 1, ok: true,
        data: { status: "queued", chatId, runId, worktreeId, recipe: "files-trash" } });
      expect(intent).toEqual(JSON.parse(await expectedBody()));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(closed => server.close(() => closed()));
    }
  });

  it("uses only the named recipe's fixed source file and accepts exact duplicate intent bytes", async () => {
    const { fetchFn, queue } = fixture(detail(), await expectedBody("sign-in"));
    await expect(queue({ recipe: "sign-in" })).resolves.toMatchObject({ status: "queued", recipe: "sign-in" });
    expect(fetchFn.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("does not overwrite a conflicting request belonging to the same run", async () => {
    const { fetchFn, queue } = fixture(detail(), "another candidate");
    await expect(queue()).rejects.toMatchObject({ code: "mac_verification_conflict" });
    expect(fetchFn.mock.calls.filter(call => call[1]?.method === "PUT")).toHaveLength(1);
  });

  it("fails if the latest completed run claims another worktree, even when an older run matches", async () => {
    const { fetchFn, queue } = fixture(detail([
      resultRun({ id: "run_previous", age: 1000 }), resultRun({ worktree: "wt_ffffffffff12" }),
    ]));
    await expect(queue()).rejects.toMatchObject({ code: "mac_verification_chat_unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects an earlier completed run after a new run fails", async () => {
    const { fetchFn, queue } = fixture(detail([
      resultRun({ id: "run_previous", age: 1000 }),
      resultRun({ status: "failed" }),
    ]));
    await expect(queue()).rejects.toMatchObject({ code: "mac_verification_chat_unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requires the latest run to belong to the selected Chat", async () => {
    const { fetchFn, queue } = fixture(detail([resultRun({ chat: "chat_other" })]));
    await expect(queue()).rejects.toMatchObject({ code: "mac_verification_response_invalid" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ age: 600_100 }], [{ age: -60_000 }], [{ project: "proj_other" }], [{ driver: "claude_code" }],
  ])("refuses stale, future, foreign or incompatible runs", async (options) => {
    const { fetchFn, queue } = fixture(detail([resultRun(options)]));
    await expect(queue()).rejects.toMatchObject({ code: "mac_verification_chat_unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("checks the linked profile owner before any upload", async () => {
    const { fetchFn, queue } = fixture();
    await expect(queue({ userId: "another_owner" })).rejects.toMatchObject({ code: "mac_verification_chat_unavailable" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a symlinked source and never uploads its digest", async () => {
    const path = join(checkout, MAC_VERIFICATION_SOURCE_BY_RECIPE["files-trash"]);
    await rm(path);
    await symlink(join(checkout, MAC_VERIFICATION_SOURCE_BY_RECIPE["sign-in"]), path);
    const { fetchFn, queue } = fixture();
    try {
      await expect(queue()).rejects.toMatchObject({ code: "mac_verification_worktree_unavailable" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      await rm(path);
      await writeFile(path, source);
    }
  });

  it("bounds Chat response bytes before parsing or uploading", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("payload", {
      headers: { "content-length": String(32 * 1024 * 1024) },
    }));
    await expect(queueMacVerification({ gatewayUrl, token: "test-bearer", ownerId,
      chatId, worktreeId, recipe: "sign-in", cwd: checkout, fetchFn }))
      .rejects.toMatchObject({ code: "mac_verification_response_invalid" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
