"use client";

import { useVoiceLiveCall, type VoiceLiveCall } from "@matrix-os/ui/voice-live";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";

const WORKLET_URL = "/audio-worklet-processor.js";

async function openShellVoiceSocket(chatId: string | undefined): Promise<WebSocket> {
  const path = chatId ? `/ws/voice/live?chatId=${encodeURIComponent(chatId)}` : "/ws/voice/live";
  return new WebSocket(await buildAuthenticatedWebSocketUrl(path));
}

/** Web shell binding for the shared live voice call. */
export function useVoiceLive(enabled: boolean, chatId: string | undefined): VoiceLiveCall {
  return useVoiceLiveCall({ enabled, chatId, openSocket: openShellVoiceSocket, workletUrl: WORKLET_URL });
}
