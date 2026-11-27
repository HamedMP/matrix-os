import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { nativeCodexMcpExecution } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import { prepareCodexTerminalMcp } from "../../packages/gateway/src/coding-agents/codex-terminal-mcp-client.js";

it("quarantines a real adapter admission when private MCP startup cleanup is unconfirmed", async () => {
  const home = await mkdtemp("/tmp/mx-terminal-cleanup-"),
    registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
    cleanupUnconfirmed = vi.fn();
  let token: string | undefined;
  const threads = createCodingAgentThreadStore({
    homePath: home,
    providers: [
      {
        providerId: "codex",
        initialRunExecution: "background",
        startThread: async ({ principal }) => {
          const lease = nativeCodexMcpExecution(principal.userId)!;
          token = lease.token;
          await prepareCodexTerminalMcp({
            ownerId: principal.userId,
            sessionId: "sess_uncertain",
            lease,
            control: {
              prepareMatrixMcp: async () => {
                throw Error("Synthetic lost acknowledgement");
              },
            } as never,
            runtime: { stopSession: async () => ({ ok: false }) } as never,
            signal: new AbortController().signal,
          });
          throw Error("Unreachable");
        },
      },
    ],
    relationValidator: { validateCreate: async () => {}, validateThread: async () => {} },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({
      providerId: "codex",
      threads,
      matrixMcpCapabilityIssuer: registry,
      gatewayPort: 4000,
    }),
    input = {
      owner: { type: "personal" as const, ownerId: "owner" },
      chatId: "chat_one",
      turnId: "cturn_one",
      runId: "run_one",
      prompt: "Synthetic",
      ownerSubmittedHerdrTurn: true as const,
      parts: herdrControlParts(),
      selection: { instanceId: "codex_default", model: "gpt-6.1-sol" },
      interactionMode: "default",
      permissionMode: "full_access",
      worktreeId: "wt_7777777777777777",
      executionRoot: home,
      signal: new AbortController().signal,
      onCleanupUnconfirmed: cleanupUnconfirmed,
    };
  try {
    await expect(
      (async () => {
        for await (const event of adapter.start!(input)) {
          expect(event.type).toBeTruthy();
        }
      })(),
    ).rejects.toThrow(/cleanup unconfirmed/i);
    expect(cleanupUnconfirmed).toHaveBeenCalledOnce();
    expect(registry.resolve(token!, "POST", "/api/chat/herdr-terminal")).toBeNull();
    await expect(adapter.start!(input).next()).rejects.toThrow("Browser run unavailable");
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("actual adapter cancellation revokes immediately but awaits delayed native MCP cleanup", async () => {
  const home = await mkdtemp("/tmp/mx-terminal-cancel-"),
    registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
    cleanupUnconfirmed = vi.fn();
  let token: string | undefined, release!: () => void;
  const prepareMatrixMcp = vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("Synthetic cancelled bootstrap")), { once: true });
      }),
  );
  const stopSession = vi.fn(
    () =>
      new Promise<{ ok: false }>((resolve) => {
        release = () => resolve({ ok: false });
      }),
  );
  const threads = createCodingAgentThreadStore({
    homePath: home,
    providers: [
      {
        providerId: "codex",
        initialRunExecution: "background",
        startThread: async ({ principal, signal }) => {
          const lease = nativeCodexMcpExecution(principal.userId)!;
          token = lease.token;
          await prepareCodexTerminalMcp({
            ownerId: principal.userId,
            sessionId: "sess_delayed",
            lease,
            control: { prepareMatrixMcp } as never,
            runtime: { stopSession } as never,
            signal: signal ?? new AbortController().signal,
          });
          throw Error("Unreachable");
        },
      },
    ],
    relationValidator: { validateCreate: async () => {}, validateThread: async () => {} },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({
      providerId: "codex",
      threads,
      matrixMcpCapabilityIssuer: registry,
      gatewayPort: 4000,
    }),
    input = {
      owner: { type: "personal" as const, ownerId: "owner" },
      chatId: "chat_one",
      turnId: "cturn_one",
      runId: "run_one",
      prompt: "Synthetic",
      ownerSubmittedHerdrTurn: true as const,
      parts: herdrControlParts(),
      selection: { instanceId: "codex_default", model: "gpt-6.1-sol" },
      interactionMode: "default",
      permissionMode: "full_access",
      worktreeId: "wt_7777777777777777",
      executionRoot: home,
      signal: new AbortController().signal,
      onCleanupUnconfirmed: cleanupUnconfirmed,
    };
  const execution = (async () => {
    for await (const event of adapter.start!(input)) {
      expect(event.type).toBeTruthy();
    }
  })();
  const observed = execution.then(
    () => undefined,
    (error) => error,
  );
  try {
    await vi.waitFor(() => expect(prepareMatrixMcp).toHaveBeenCalledOnce());
    let settled = false;
    const cancelled = adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId }).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(registry.resolve(token!, "POST", "/api/chat/herdr-terminal")).toBeNull();
    expect(settled).toBe(false);
    release();
    expect(await cancelled).toBeInstanceOf(Error);
    expect(await observed).toBeInstanceOf(Error);
    expect(cleanupUnconfirmed).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await observed;
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
