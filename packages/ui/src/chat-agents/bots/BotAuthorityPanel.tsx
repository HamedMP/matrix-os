import { groupBotAuthority, type BotAuthorityView, type BotMemoryMutationRequest } from "@matrix-os/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { RememberedItemPart } from "./RememberedItemPart.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

export function BotAuthorityPanel({ view, onRevoke, onMemory, onChanged, compact = false, title = "What this bot can access", beforeMemory }: {
  compact?: boolean; title?: string; beforeMemory?: ReactNode; view: BotAuthorityView;
  onRevoke: (grantId: string) => Promise<unknown>;
  onMemory: (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => Promise<unknown>;
  onChanged?: () => void;
}) {
  const [current, setCurrent] = useState(view);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { setCurrent(view); }, [view]);
  const groups = groupBotAuthority(current);
  const change = async (key: string, action: () => Promise<unknown>, apply: (value: BotAuthorityView) => BotAuthorityView) => {
    if (pending) return;
    setPending(key);
    setError("");
    try {
      await action();
      setCurrent((value) => apply(value));
      onChanged?.();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Bot authority change failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Could not change bot access. Refresh and try again.");
    } finally {
      setPending(null);
    }
  };
  return <section aria-label="Bot authority" className={compact ? "grid gap-5" : "grid gap-5 rounded-2xl border p-4"}>
    <div><h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs" style={chatAgentMutedStyle}>Access and memory are shown from saved settings.</p></div>
    <div className="grid gap-3">
      {groups.length ? groups.map((group) => <div key={group.service} className={compact ? "grid gap-2 border-b pb-3" : "grid gap-2 rounded-xl border p-3"}>
        <h4 className="text-sm font-medium">{group.service.replaceAll("_", " ")}</h4>
        <p className="text-xs" style={chatAgentMutedStyle}>{group.state.replaceAll("_", " ")}</p>
        {group.grants.map((grant) => <div key={grant.grantId} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{grant.accountLabel} · {grant.effects.join(", ")}</span>
          <button type="button" aria-label={`Revoke ${grant.accountLabel}`} className={chatAgentButtonClass} disabled={!!pending}
            onClick={() => { void change(grant.grantId, () => onRevoke(grant.grantId),
              (value) => {
                const grants = value.grants.filter((entry) => entry.grantId !== grant.grantId);
                return { ...value, grants, connections: value.connections.map((connection) => (
                  connection.service === grant.service && connection.state === "granted"
                    && !grants.some((entry) => entry.service === grant.service)
                    ? { ...connection, state: "connected_not_granted" as const } : connection
                )) };
              }); }}>Revoke</button>
        </div>)}
      </div>) : <p className="text-sm" style={chatAgentMutedStyle}>No integration access recorded.</p>}
    </div>
    {beforeMemory}
    <div className="grid gap-3"><h4 className="text-sm font-semibold">Remembered</h4>
      {current.memory.items.length ? current.memory.items.map((item) => <div key={item.itemId} className="grid gap-2 rounded-xl border p-3">
        <RememberedItemPart item={item} />
        <div className="flex flex-wrap gap-2">
          {!item.confirmed ? <button type="button" aria-label="Confirm memory" className={chatAgentButtonClass} disabled={!!pending}
            onClick={() => { void change(item.itemId, () => onMemory(item.itemId, "confirm", { baseRevision: item.revision }),
              (value) => ({ ...value, memory: { ...value.memory, items: value.memory.items.map((entry) => entry.itemId === item.itemId
                ? { ...entry, confirmed: true, revision: entry.revision + 1 } : entry) } })); }}>Confirm</button> : null}
          <button type="button" aria-label="Forget memory" className={chatAgentButtonClass} disabled={!!pending}
            onClick={() => { void change(item.itemId, () => onMemory(item.itemId, "forget", { baseRevision: item.revision }),
              (value) => ({ ...value, memory: { ...value.memory, items: value.memory.items.filter((entry) => entry.itemId !== item.itemId) } })); }}>Forget</button>
        </div>
      </div>) : <p className="text-sm" style={chatAgentMutedStyle}>Nothing remembered yet.</p>}
    </div>
    {error ? <p role="alert" className="text-xs">{error}</p> : null}
  </section>;
}
