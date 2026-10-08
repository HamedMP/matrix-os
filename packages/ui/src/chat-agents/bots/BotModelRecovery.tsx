import { createContext, useContext, useMemo, useState, useRef, useLayoutEffect, type ReactNode } from "react";
import type { ChatAgentClient } from "../client.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

type Scope = { agentId?: string | null; client?: ChatAgentClient };
type DetailsRequest = { scope: Scope; agentId: string; client: ChatAgentClient; sequence: number };
type Recovery = { agentId: string; client: ChatAgentClient; detailsRequest: DetailsRequest | null;
  chooseModel(): void; onSetup?: () => void; onRefreshCatalog?: () => void };
const Context = createContext<Recovery | null>(null);

/** Authenticated Chat binding owns recovery. An unresolved/ordinary Chat never gets Bot actions. */
export function BotModelRecoveryProvider({ agentId, client, onSetup, onRefreshCatalog, children }: {
  agentId?: string | null; client?: ChatAgentClient; onSetup?: () => void; onRefreshCatalog?: () => void; children: ReactNode;
}) {
  const scope = useMemo(() => ({ agentId, client }), [agentId, client]);
  const currentScope = useRef<Scope | null>(scope);
  useLayoutEffect(() => { currentScope.current = scope; return () => { if (currentScope.current === scope) currentScope.current = null; }; }, [scope]);
  const [request, setRequest] = useState<DetailsRequest | null>(null);
  const value = useMemo<Recovery | null>(() => agentId && client ? { agentId, client,
    detailsRequest: request?.scope === scope ? request : null,
    chooseModel: () => { if (currentScope.current === scope) setRequest(previous => ({ scope, agentId, client, sequence: (previous?.sequence ?? 0) + 1 })); },
    onSetup, onRefreshCatalog,
  } : null, [agentId, client, scope, request, onSetup, onRefreshCatalog]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useBotModelRecovery() { return useContext(Context); }

/** Replaces a canonical model failure in place; never resubmits or changes authority. */
export function BotModelFailureNotice() {
  const recovery = useBotModelRecovery();
  if (!recovery) return null;
  return <section role="status" aria-label="Bot model unavailable" className="grid w-full max-w-lg gap-2 rounded-xl border p-3 text-sm"
    style={{ borderColor: "var(--border-default,var(--border))", color: "var(--text-primary,var(--foreground))" }}>
    <h3 className="font-medium">Choose an available model</h3>
    <p className="text-xs leading-5" style={chatAgentMutedStyle}>This request could not start with the configured model. Check availability or choose another model before sending again.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={chatAgentButtonClass} onClick={recovery.chooseModel}>Choose model</button>
      {recovery.onRefreshCatalog ? <button type="button" className={chatAgentButtonClass} onClick={recovery.onRefreshCatalog}>Check availability</button> : null}
      {recovery.onSetup ? <button type="button" className={chatAgentButtonClass} onClick={recovery.onSetup}>Agents & providers</button> : null}
    </div>
  </section>;
}
