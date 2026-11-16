import { useRoutineAction } from "./use-routine-action.js";
import { ROUTINE_ACTION_NOTICE, ROUTINE_ACTION_OUTCOME as outcome, routineActionDetails } from "@matrix-os/contracts";
import type { RoutineActionClient } from "./client.js";
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "../chat-agents/theme.js";

/** Shared Web Canvas/Web Desktop/Electron Desktop/owner-browser card. Native Mobile uses the same server DTO/copy. */
export function RoutineActionConfirmation({ client, challengeId, identity, openConfirmation }: {
  client: RoutineActionClient; challengeId: string; identity: string; openConfirmation?: (id: string, signal?: AbortSignal) => Promise<void>;
}) {
  const { view, status, error, busy, opened, active, submit } = useRoutineAction({ client, challengeId, identity, openConfirmation });
  return <section aria-label="Routine operation confirmation" className="ph-no-capture min-w-0 space-y-3 rounded-xl border p-4 text-sm" style={chatAgentSurfaceStyle}>
    <p className="font-semibold">{view?.title ?? "Routine operation confirmation"}</p>
    <p style={chatAgentMutedStyle}>{ROUTINE_ACTION_NOTICE}</p>
    {view ? <pre className="whitespace-pre-wrap break-words font-sans">{routineActionDetails(view)}</pre> : null}
    <p role="status" style={chatAgentMutedStyle}>{status ? outcome[status] : "Loading confirmation…"}</p>
    {active ? <div className="flex flex-wrap items-center gap-2">{openConfirmation
      ? <button type="button" className={chatAgentPrimaryButtonClass} disabled={busy} onClick={() => void submit("approve")}>{opened ? "Reopen owner confirmation" : "Confirm in browser"}</button>
      : (["approve", "decline", "cancel"] as const).map(decision => <button type="button" className={decision === "approve" ? chatAgentPrimaryButtonClass : chatAgentButtonClass} key={decision} disabled={busy} onClick={() => void submit(decision)}>{decision === "approve" ? "Allow once" : decision === "decline" ? "Decline" : "Cancel request"}</button>)}</div> : null}
    {opened && active ? <p>Complete the decision in your owner browser. Opening it does not allow the operation.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
