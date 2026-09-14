// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { createCanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";

it.each([
  { mode: "direct", repeat: "already_accepted", reconnect: false },
  { mode: "queued", repeat: "already_accepted", reconnect: false },
  { mode: "direct", repeat: "already_accepted", reconnect: true },
  { mode: "queued", repeat: "already_accepted", reconnect: true },
  { mode: "direct", repeat: "accepted", reconnect: false },
  { mode: "direct", repeat: "accepted", reconnect: true },
] as const)("keeps $mode steering live with $repeat responses (reconnect=$reconnect)", async ({ mode, repeat, reconnect }) => {
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  const owner = { type: "personal" as const, ownerId: "owner_stream" };
  const { snapshot } = createCanonicalChatFixture("running");
  const chatId = snapshot.chat.id;
  const run = snapshot.runs[0]!;
  const turn = snapshot.turns[0]!;
  await repository.create(owner, { id: chatId, clientRequestId: "req_stream", title: "Stream" });
  await repository.admitTurn(owner, {
    chatId, baseRevision: 0, message: snapshot.messages[0]!, turn: { ...turn, status: "accepted" },
    run: { ...run, status: "accepted", capabilitySnapshot: { ...run.capabilitySnapshot, steering: "same_run" } },
  });
  await repository.markRunRunning(owner, { chatId, runId: run.id, startedAt: snapshot.chat.createdAt });
  if (mode === "queued") await repository.enqueueQueuedTurn(owner, {
    chatId, baseRevision: (await repository.get(owner, chatId))!.chat.revision,
    queuedTurnId: "qturn_stream", clientRequestId: "req_queue_stream",
    parts: [{ type: "text", text: "continue" }], driverKind: run.driverKind,
    selection: run.selection, interactionMode: run.interactionMode, permissionMode: run.permissionMode,
    capabilitySnapshot: run.capabilitySnapshot, createdAt: snapshot.chat.createdAt,
  });
  const initial = (await repository.getDetailPage(owner, chatId, { limit: 200 }))!;
  const stream = createCanonicalChatEventStream({ repository });
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => ({ userId: owner.ownerId, source: "jwt" }) });
  let release: (() => void) | undefined;
  let deliveryGate: Promise<void> | undefined;
  let disconnect: (() => void) | undefined;
  const openStream = vi.fn(async ({ signal, cursor }: { signal: AbortSignal; cursor?: number }) => {
    const response = await app.request(`/api/chats/events${cursor === undefined ? "" : `?cursor=${cursor}`}`, {
      signal, headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
    });
    return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      start(controller) { disconnect = () => controller.terminate(); },
      async transform(chunk, controller) { await deliveryGate; controller.enqueue(chunk); },
    })), { headers: response.headers });
  });
  const source = createCanonicalChatEventSource({ openStream });
  const getDetail = vi.fn(async () => initial);
  let firstRequest = true;
  const steer = async () => {
      const suffix = !firstRequest && repeat === "accepted" ? "_second" : "";
      const requestId = `req_steer_stream${suffix}`;
      // Provider output can commit after the UI captures its request revision,
      // while the independent HTTP response arrives before these SSE bytes.
      if (firstRequest) await repository.appendAssistantDelta(owner, { chatId, runId: run.id,
        messageId: "msg_streaming", delta: "hello", createdAt: snapshot.chat.createdAt });
      firstRequest = false;
      const input = { chatId, runId: run.id, expectedTurnId: turn.id,
        steerId: `steer_stream${suffix}`, messageId: `msg_steer_stream${suffix}`, clientRequestId: requestId,
        parts: [{ type: "text" as const, text: "continue" }], createdAt: snapshot.chat.createdAt };
      const begun = mode === "queued" ? await repository.beginQueuedTurnSteer(owner, {
        ...input, queuedTurnId: "qturn_stream", baseRevision: initial.record.chat.revision,
      }) : await repository.beginSteer(owner, input);
      if (begun.status === "accepted") return { message: begun.message, runId: run.id, turnId: turn.id, steering: "already_accepted" as const };
      const accepted = { chatId, runId: run.id, clientRequestId: requestId, acceptedAt: snapshot.chat.createdAt };
      const message = mode === "queued" ? await repository.acceptQueuedTurnSteer(owner, {
        ...accepted, queuedTurnId: "qturn_stream",
      }) : await repository.acceptSteer(owner, accepted);
      return { message, runId: run.id, turnId: turn.id, steering: "accepted" as const };
  };
  const client = {
    list: async () => ({ items: [initial.record] }),
    getDetail,
    acknowledgeCompletion: async () => (await repository.get(owner, chatId))!,
    steerRun: steer,
    steerQueuedTurn: steer,
  } as CanonicalChatClient;
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null,
    active: true, initialChatId: chatId, eventSource: source }));
  try {
    await act(async () => { await source.start(); });
    await waitFor(() => expect(hook.result.current.detail?.record.chat.revision).toBe(initial.record.chat.revision));
    deliveryGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      expect(await (mode === "queued" ? hook.result.current.steerQueuedTurn("qturn_stream")
        : hook.result.current.steerActiveRun([{ type: "text", text: "continue" }]))).not.toBeNull();
    });
    expect(hook.result.current.detail?.messages.some((message) => message.id === "msg_streaming")).toBe(false);
    await act(async () => { release?.(); });
    await waitFor(() => expect(hook.result.current.detail?.messages.find((message) => message.id === "msg_streaming")?.parts)
      .toEqual([{ type: "text", text: "hello" }]));
    await act(async () => {
      await repository.appendAssistantDelta(owner, { chatId, runId: run.id,
        messageId: "msg_streaming", delta: " world", createdAt: snapshot.chat.createdAt });
    });
    await waitFor(() => expect(hook.result.current.detail?.messages.find((message) => message.id === "msg_streaming")?.parts)
      .toEqual([{ type: "text", text: "hello world" }]));
    deliveryGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      const response = mode === "queued" ? await hook.result.current.steerQueuedTurn("qturn_stream")
        : await hook.result.current.steerActiveRun([{ type: "text", text: "continue" }]);
      expect(response?.steering).toBe(repeat);
      release?.();
      await repository.appendRunActivities(owner, chatId, run.id, [{ id: "activity_stream", chatId,
        runId: run.id, type: "run.status", status: "running", occurredAt: snapshot.chat.createdAt }]);
    });
    await waitFor(() => expect(hook.result.current.detail?.activities.some((activity) => activity.id === "activity_stream")).toBe(true));
    expect(hook.result.current.detail?.messages.filter((message) => message.id === "msg_steer_stream")).toHaveLength(1);
    await act(async () => {
      await repository.appendAssistantDelta(owner, { chatId, runId: run.id,
        messageId: "msg_streaming", delta: " live", createdAt: snapshot.chat.createdAt });
    });
    await waitFor(() => expect(hook.result.current.detail?.messages.find((message) => message.id === "msg_streaming")?.parts)
      .toEqual([{ type: "text", text: "hello world live" }]));
    if (reconnect) {
      await act(async () => { disconnect?.(); });
      await act(async () => {
        await repository.appendAssistantDelta(owner, { chatId, runId: run.id,
          messageId: "msg_streaming", delta: " replay", createdAt: snapshot.chat.createdAt });
      });
      await waitFor(() => expect(hook.result.current.detail?.messages.find((message) => message.id === "msg_streaming")?.parts)
        .toEqual([{ type: "text", text: "hello world live replay" }]));
      expect(openStream).toHaveBeenCalledTimes(2);
      expect(openStream.mock.calls[1]?.[0].cursor).toBeGreaterThan(0);
    }
    await act(async () => {
      await repository.finishRun(owner, { chatId, runId: run.id, outcome: "completed", completedAt: snapshot.chat.createdAt });
    });
    await waitFor(() => expect(hook.result.current.detail?.record.activeRun).toBeUndefined());
    expect(hook.result.current.detail?.runs.find((candidate) => candidate.id === run.id)?.status).toBe("completed");
    // One initial snapshot; reconnection deliberately reconciles once. Healthy
    // steering/content delivery never uses per-event polling or reload.
    expect(getDetail).toHaveBeenCalledTimes(reconnect ? 2 : 1);
  } finally {
    release?.(); hook.unmount(); source.dispose(); stream.shutdown(); await repository.kysely.destroy();
  }
});
