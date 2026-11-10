import { isPrivatePreviewHandle } from "@matrix-os/contracts";
import { BotsWorkspace, useHostedBotsAvailability } from "@matrix-os/ui";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { AppError } from "../../../../shared/app-error";
import { useConnection } from "../../stores/connection";
import EmbedHost from "../embeds/EmbedHost";

export function useDesktopHostedBotsCapability() {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  const generation = useConnection((state) => state.authGeneration);
  const scope = JSON.stringify([platformHost, runtimeSlot, userId, generation]);
  const transport = useMemo(() => isPrivatePreviewHandle(runtimeSlot) ? api?.forRuntime(runtimeSlot) ?? null : null,
    [api, runtimeSlot, scope]);
  const [probe, setProbe] = useState<{ transport: NonNullable<typeof transport>; mode: "oss" | "legacy" | "unavailable" }>();
  useEffect(() => {
    if (!transport) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const runtime = transport;
    const report = (mode: "oss" | "legacy" | "unavailable") => {
      if (!disposed) setProbe({ transport: runtime, mode });
    };
    const check = () => {
      attempts++;
      void runtime.get<unknown>("/api/hosted-bots/runtime", { omitErrorBody: true, maxBytes: 512 }).then((data) => {
        report(typeof data === "object" && data !== null && Reflect.get(data, "ready") === true ? "oss" : "unavailable");
      }, (error: unknown) => {
        if (disposed) return;
        const status = error instanceof AppError ? error.httpStatus : undefined;
        if (status === 404) {
          report("legacy");
          return;
        }
        report("unavailable");
        if ((status === 503 || status === undefined) && attempts < 12) {
          retry = setTimeout(check, 2000);
        }
      });
    };
    check();
    return () => { disposed = true; clearTimeout(retry); };
  }, [transport]);

  const mode = probe?.transport === transport ? probe.mode : undefined;
  const fallback = useHostedBotsAvailability(mode === "legacy" ? transport : null);
  return { scope, transport, mode: mode === "oss" ? "oss" as const : fallback ? "matrix" as const : null };
}

const desktopHostedBots = createContext<ReturnType<typeof useDesktopHostedBotsCapability> | null>(null);
export const DesktopHostedBotsProvider = desktopHostedBots.Provider;

export function DesktopBotsWorkspace(props: {
  active: boolean;
  visible: boolean;
  layoutRevision?: string;
  visualScale?: number;
}) {
  const capability = useContext(desktopHostedBots);
  if (capability?.mode === "oss") return <EmbedHost key={capability.scope} kind="hosted-bots" {...props} />;
  if (capability?.mode === "matrix") return <BotsWorkspace key={capability.scope} transport={capability.transport} active={props.active} />;
  return <p className="m-auto p-6 text-sm" role="status">Bots is unavailable on this Computer.</p>;
}
