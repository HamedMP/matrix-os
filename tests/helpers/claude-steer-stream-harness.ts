import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { vi } from "vitest";
import {
  CanonicalChatTransportFrameSchema,
  CanonicalProviderCatalogSchema,
  type CanonicalChatTransportFrame,
} from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";

export const BEFORE_STEER = "I am reviewing the original module.";
export const STEER_REQUEST = "Focus on the streaming module instead.";
export const AFTER_STEER = "I have switched to the streaming module.";
export const FINAL_TEXT = "The focused streaming review is complete.";

// Only the external CLI process is controlled. No canonical events are injected.
class ControlledClaudeChild extends EventEmitter {
  readonly inputFrames: unknown[] = [];
  readonly stdin = { write: (frame: string, callback?: (error?: Error | null) => void) => { this.inputFrames.push(JSON.parse(frame)); callback?.(); return true; } };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exited = false;
  resultReleased = false;

  kill(signal: NodeJS.Signals) {
    queueMicrotask(() => this.exit(null, signal));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  line(value: unknown, fragmented = false) {
    if (this.exited) throw new Error("Cannot emit output from an exited fixture child");
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (fragmented) {
      const split = Math.floor(bytes.length / 2);
      this.stdout.emit("data", bytes.subarray(0, split));
      this.stdout.emit("data", bytes.subarray(split));
    } else this.stdout.emit("data", bytes);
  }

  initialize() {
    this.line({ type: "system", subtype: "init", session_id: "claude_stream_session", model: "sonnet" });
  }

  text(text: string, fragmented = false) {
    this.line({ type: "stream_event", event: {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    } }, fragmented);
    this.line({ type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
    } }, fragmented);
    this.line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, fragmented);
  }

  tool() {
    this.line({ type: "stream_event", event: { type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: "tool_stream_review", name: "Read",
        input: { file_path: "/safe/project/src/streaming.ts" } },
    } });
  }

  finish() {
    if (this.exited) return;
    this.resultReleased = true;
    this.text(FINAL_TEXT);
    this.line({ type: "result", subtype: "success", is_error: false,
      result: FINAL_TEXT, session_id: "claude_stream_session" });
    this.exit(0);
  }
}

export async function createClaudeSteerStreamHarness() {
  const owner = { type: "personal" as const, ownerId: "owner_claude_stream" };
  const principal = { userId: owner.ownerId, source: "jwt" as const };
  const chatId = "chat_claude_stream";
  const selection = { instanceId: "claude_stream", model: "sonnet", options: [{ id: "effort", value: "high" }] };
  const fixture = createCanonicalProviderCatalogFixture();
  const catalog = CanonicalProviderCatalogSchema.parse({ ...fixture,
    drivers: [{ ...fixture.drivers[0], kind: "claude_code", displayName: "Claude Code" }],
    instances: [{ ...fixture.instances[0], id: selection.instanceId, driverKind: "claude_code",
      displayName: "Claude Code", models: [{ ...fixture.instances[0]!.models[0], id: "sonnet", displayName: "Sonnet" }],
      defaultSelection: selection,
      options: [{ id: "effort", label: "Reasoning", kind: "enum", placement: "composer",
        values: [{ value: "high", label: "High" }] }],
      supports: { ...fixture.instances[0]!.supports, steering: "same_run" },
    }],
  });
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_create_stream", title: "Claude streaming" });
  const children: ControlledClaudeChild[] = [];
  const spawn = vi.fn<CanonicalCliSpawn>(() => {
    if (children.length >= 4) throw new Error("Unexpected extra Claude child");
    const child = new ControlledClaudeChild();
    children.push(child);
    queueMicrotask(() => child.initialize());
    return child;
  });
  const adapter = createClaudeChatProviderAdapter({
    homePath: "/safe/home", spawnFn: spawn, resolveCredentialEnv: async () => ({}),
  });
  const root = { ref: { kind: "project" as const, projectId: "project_stream" },
    fingerprint: "a".repeat(64), primaryWorkspaceRoot: "/safe/project", projectSlug: "stream" };
  const orchestrator = new CanonicalChatOrchestrator({ repository,
    catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]),
    executionRoots: { resolve: async () => root, revalidate: async () => root },
  });
  const stream = createCanonicalChatEventStream({ repository });
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principal });
  const frames: CanonicalChatTransportFrame[] = [];
  const openStream = vi.fn(async ({ signal, cursor }: { signal: AbortSignal; cursor?: number }) => {
    const response = await app.request(`/api/chats/events?messageVersion=2${cursor === undefined ? "" : `&cursor=${cursor}`}`, {
      signal, headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
    });
    const decoder = new TextDecoder();
    let buffered = "";
    return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length > 512_000) throw new Error("Fixture SSE buffer limit exceeded");
        let end: number;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6)).join("\n");
          if (data) {
            if (frames.length >= 256) throw new Error("Fixture SSE frame limit exceeded");
            frames.push(CanonicalChatTransportFrameSchema.parse(JSON.parse(data)));
          }
        }
        controller.enqueue(chunk);
      },
    })), { status: response.status, headers: response.headers });
  });
  const getDetail = async () => (await repository.getDetailPage(owner, chatId, { limit: 200 }))!;
  return {
    owner, principal, chatId, catalog, children, spawn, frames, openStream, getDetail, repository, orchestrator,
    async admit() {
      return orchestrator.admitTurn(principal, owner, chatId, { clientRequestId: "req_stream_turn", baseRevision: 0,
        parts: [{ type: "text", text: "Review the original module." }], selection,
        interactionMode: "default", permissionMode: "supervised", executionRoot: root.ref });
    },
    async steer(runId: string, turnId: string) {
      return orchestrator.steerRun(owner, chatId, runId, { clientRequestId: "req_stream_steer",
        expectedTurnId: turnId, parts: [{ type: "text", text: STEER_REQUEST }] });
    },
    async close() {
      await orchestrator.close();
      stream.shutdown();
      await repository.kysely.destroy();
    },
  };
}

export function contentFrames(frames: CanonicalChatTransportFrame[]) {
  return frames.filter((frame) => frame.type === "chat.content");
}

export function messageFrame(frames: CanonicalChatTransportFrame[], text: string) {
  return contentFrames(frames).find((frame) => frame.content.messageDelta?.message.parts
    .some((part) => part.type === "text" && part.text === text));
}
