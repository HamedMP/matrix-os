import { useState } from "react";
import { MessageBoard } from "@matrix-os/ui/message-board";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration } from "../../stores/runtime-generation";
import { createDesktopMessageBoardClient } from "./desktop-board-client";

/** Message Board (spec 2700) in Electron Desktop: the same shared viewer and HTTP client as Web Desktop. */
export default function MessageBoardWorkspace() {
  const platformHost = useConnection((state) => state.platformHost);
  const slot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const connected = useConnection((state) => state.api !== null);
  if (!connected || !platformHost) {
    return <div className="m-auto text-sm text-[var(--text-tertiary)]">Connect to your Matrix computer to open the Message Board.</div>;
  }
  // A runtime switch or new sign-in remounts with a fresh client and socket.
  return <MessageBoardSession key={`${slot}:${authGeneration}:${captureRuntimeGeneration()}`} platformHost={platformHost} runtimeSlot={slot} />;
}

function MessageBoardSession({ platformHost, runtimeSlot }: { platformHost: string; runtimeSlot: string }) {
  const [client] = useState(() => createDesktopMessageBoardClient({
    platformHost, runtimeSlot,
    onUnauthorized: () => { void invoke("auth:session-expired", {}); },
  }));
  return <div className="h-full min-h-0 overflow-hidden">
    <MessageBoard client={client} />
  </div>;
}
