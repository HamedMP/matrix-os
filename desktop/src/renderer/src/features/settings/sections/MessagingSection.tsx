import { WhatsAppSettingsPanel } from "@matrix-os/ui";
import { ChatAppsPanel, type MessagingBridgeFetch, type MessagingBridgeSubscribe } from "@matrix-os/ui/messaging";
import { WHATSAPP_SETTINGS_PATH } from "@matrix-os/contracts";
import { useConnection } from "../../../stores/connection";
import { invoke } from "../../../lib/operator";
import { buildGatewayUrl } from "../../../lib/api";
import { getKernelSocket } from "../../../lib/kernel-wiring";

// The trusted core injects the gateway Authorization header at the network
// layer for the active gateway origin, exactly as it does for the api client.
const subscribeOwnerEvents: MessagingBridgeSubscribe = (listener) => {
  const socket = getKernelSocket();
  if (!socket) return null;
  try {
    return socket.subscribe(listener);
  } catch (error: unknown) {
    console.warn("[messaging] Owner events unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
};

export default function MessagingSection() {
  const api = useConnection((s) => s.api);
  const userId = useConnection((s) => s.userId);
  const generation = useConnection((s) => s.authGeneration);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const platformOrigin = useConnection((s) => s.platformHost) || null;
  const scope = JSON.stringify([userId, generation, platformOrigin]);
  const allowDevelopmentOrigin = import.meta.env.DEV;
  const open = async (url: string) => {
    await invoke("shell:open-external", { url });
  };
  const bridgeFetch: MessagingBridgeFetch | null = api
    ? (path, init) => fetch(buildGatewayUrl(api.baseUrl, path, runtimeSlot), init)
    : null;
  return (
    <>
      <h2 className="text-xl font-semibold">Messaging</h2>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">
        Your own Matrix, in the apps you already use.
      </p>
      <WhatsAppSettingsPanel
        platformOrigin={platformOrigin}
        allowDevelopmentOrigin={allowDevelopmentOrigin}
        key={String(Boolean(api))}
        scope={scope}
        load={async () => {
          if (!api) throw new Error("Connection unavailable");
          return api.get(WHATSAPP_SETTINGS_PATH, { maxBytes: 4096 });
        }}
        onOpen={open}
      />
      <ChatAppsPanel
        scope={JSON.stringify([userId, generation, platformOrigin, runtimeSlot])}
        fetch={bridgeFetch}
        subscribe={subscribeOwnerEvents}
        onOpenExternal={open}
      />
    </>
  );
}
