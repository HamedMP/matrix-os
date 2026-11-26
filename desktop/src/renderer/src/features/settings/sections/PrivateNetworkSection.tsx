import { useMemo } from "react";
import { createPrivateNetworkClient, PrivateNetworkPanel } from "@matrix-os/ui/private-network";
import { useConnection } from "../../../stores/connection";

/** Electron Desktop Settings -> System private network panel, bound to the active runtime. */
export default function PrivateNetworkSection() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot),
    authGeneration = useConnection((s) => s.authGeneration);
  const client = useMemo(() => {
    if (!api) return null;
    const runtime = api.forRuntime(runtimeSlot);
    return createPrivateNetworkClient({
      get: (path, signal) => runtime.get(path, { signal, cache: "no-store" }),
      post: (path, body, signal, options) =>
        runtime.post(path, body, options?.timeoutMs ? { signal, timeoutMs: options.timeoutMs } : { signal }),
      delete: (path, body, signal) => runtime.delete(path, body, { signal }),
    });
  }, [api, runtimeSlot]);
  if (!client) return null;
  return <PrivateNetworkPanel key={`${runtimeSlot}:${authGeneration}`} client={client} />;
}
