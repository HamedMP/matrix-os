import { expect, it, vi } from "vitest";
import { createAoedeController } from "../../packages/ui/src/aoede/controller";
import type { AoedeApi } from "../../packages/ui/src/aoede/client";
import type { VoiceSessionClient, VoiceSessionClientSnapshot } from "../../packages/ui/src/voice-session/client-types";
import { VoiceSessionController } from "../../packages/ui/src/voice-session/controller";
import type { AoedeBootstrapResponse, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
it("shows a later typed reply instead of retaining ended native captions", async () => {
  const fixture = createCanonicalChatFixture("idle").snapshot;
  const catalog = createCanonicalProviderCatalogFixture();
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const binding: AoedeBootstrapResponse = { chatId: fixture.chat.id,
    scope: { kind: "workspace", id: "main", label: "Workspace" }, selection,
    capability: { contractVersion: 1, surface: "web_desktop", status: "available",
      transportModes: ["relayed_websocket"], turnModes: ["hands_free"], conversationMode: "native_live",
      supportsInterruption: true, resume: "rebuild_only", sessionOnly: "unsupported",
      actionMode: "conversation_only", actionCancellation: "none", supportsInputSelection: false,
      supportsOutputSelection: false } };
  let detail: CanonicalChatDetailResponse = { record: { chat: { ...fixture.chat, currentSelection: selection } },
    messages: [], turns: [], runs: [], activities: [] };
  let listener = () => {};
  const inner = new VoiceSessionController({ initialEpoch: 1 });
  let state: VoiceSessionClientSnapshot = { phase: "idle", error: null, notice: null,
    sessionId: "vs_test", chatId: fixture.chat.id, reconnectStatus: null, voice: null };
  const media = { getSnapshot: () => state, subscribe: (fn: () => void) => { listener = fn; return () => {}; },
    startVoice: async () => { state = { ...state, phase: "active", voice: { ...inner.getState(),
      state: "listening", companion: { captions: { response: "Old spoken answer" }, tasks: [], sources: [] } } }; listener(); },
    end: async () => { state = { ...state, phase: "ended" }; listener(); }, dispose: vi.fn() } as unknown as VoiceSessionClient;
  const createTurn = vi.fn(async () => { detail = { ...detail,
    record: { chat: { ...detail.record.chat, revision: 1 } }, messages: [
      { id: "msg_user", chatId: fixture.chat.id, seq: 1, role: "user", state: "committed",
        createdAt: fixture.chat.createdAt, parts: [{ type: "text", text: "New typed question" }] },
      { id: "msg_reply", chatId: fixture.chat.id, seq: 2, role: "assistant", state: "committed",
        createdAt: fixture.chat.createdAt, parts: [{ type: "text", text: "Fresh typed answer" }] },
    ] }; });
  const api = { bootstrap: async () => binding, detail: async () => detail, providers: async () => catalog,
    createTurn, events: () => ({ subscribe: () => ({ dispose: vi.fn() }), start: async () => {}, dispose: vi.fn() }) } as unknown as AoedeApi;
  const controller = createAoedeController({ identityKey: "test/ended", baseUrl: "https://runtime.test", surface: "web_desktop" },
    { api, voiceFactory: () => media });
  try {
    await controller.open(); await controller.start();
    expect(controller.getSnapshot().canonical.captions.response).toBe("Old spoken answer");
    await controller.end();
    expect(await controller.sendText("New typed question")).toBe(true);
    expect(createTurn).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().canonical.captions).toMatchObject({ utterance: "New typed question", response: "Fresh typed answer" });
  } finally { controller.dispose(); }
});
