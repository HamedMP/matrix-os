import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HarnessWorkflowPanel } from "../../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { createDesktopProviderWorkflowClient } from "../../../desktop/src/renderer/src/features/settings/provider-workflow-transport";
import { createApiClient } from "../../../desktop/src/renderer/src/lib/api";
import type { ProviderWorkflowUICapability } from "../../../packages/ui/src/agents-providers/types";

function Fixture() {
  const [capability, setCapability] = useState<ProviderWorkflowUICapability | null>(null);
  const [connected, setConnected] = useState(false);
  const [terminal, setTerminal] = useState("");
  const client = useMemo(() => createDesktopProviderWorkflowClient(createApiClient({ baseUrl: location.origin, getRuntimeSlot: () => "primary" }), () => true), []);
  useEffect(() => {
    const controller = new AbortController();
    void client.capabilities(controller.signal).then(rows => { if (!controller.signal.aborted) setCapability(rows[0]); }).catch(error => { console.error("Provider fixture discovery failed", error); });
    return () => controller.abort();
  }, [client]);
  if (!capability) return <p role="status">Loading connections</p>;
  return <>
    <HarnessWorkflowPanel harness={{ id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState: connected ? "authenticated" : "unauthenticated" }}
      capability={capability} client={client} disabled={false}
      onRefresh={() => setConnected(true)} onOpenTerminal={setTerminal}
      renderConnection={action => <article><p>Connected on this computer</p>{action}</article>} />
    {terminal && <p role="status">Terminal opened: {terminal}</p>}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
