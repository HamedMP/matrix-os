import { useCallback } from "react";
import { useVoiceLiveCall, VoiceLiveOverlay } from "@matrix-os/ui/voice-live";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { buildVoiceLiveWsUrl, useDesktopVoiceCall } from "./voice-call-store";

const WORKLET_URL = "./audio-worklet-processor.js";

async function openVoiceSocket(url: string): Promise<WebSocket> {
  return new WebSocket(url);
}

function openVoiceChat(chatId: string): void {
  useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatId, chatView: "conversation", closable: false });
}

/** Electron Desktop placement of the shared live voice overlay. */
export default function DesktopVoiceCall() {
  const active = useDesktopVoiceCall((s) => s.active);
  const chatId = useDesktopVoiceCall((s) => s.chatId);
  const end = useDesktopVoiceCall((s) => s.end);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const openSocket = useCallback(
    (id: string | undefined) => openVoiceSocket(buildVoiceLiveWsUrl(platformHost, runtimeSlot, id)),
    [platformHost, runtimeSlot],
  );
  const call = useVoiceLiveCall({ enabled: active, chatId, openSocket, workletUrl: new URL(WORKLET_URL, window.location.href).toString() });
  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: DESKTOP_Z_INDEX.voiceCall }}>
      <VoiceLiveOverlay active call={call} onEnd={end} onOpenChat={openVoiceChat} />
    </div>
  );
}
