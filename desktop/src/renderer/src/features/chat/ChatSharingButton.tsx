import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void> }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  return <SharedButton {...props} handle={handle} runtimeSlot={runtimeSlot} platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost} />;
}
