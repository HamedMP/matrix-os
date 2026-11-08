import * as Popover from "@radix-ui/react-popover";
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "../chat-agents/theme.js";
import type { RoutineFullAccessController } from "./use-routine-full-access.js";

const notice = "Schedule activation, background model consent and integration permissions remain separate.";
const controlClass = `${chatAgentButtonClass} min-h-11 min-w-0 max-w-full whitespace-normal text-left`;
const primaryClass = `${chatAgentPrimaryButtonClass} min-h-11 min-w-0 max-w-full whitespace-normal text-left`;
export function RoutineFullAccessConsentContent({ controller }: { controller: RoutineFullAccessController }) {
  const { status, consent, challenge, browserOrigin, grantEnabled, busy } = controller;
  const scope = consent ?? challenge;
  return <section aria-label="Routine CLI access" className="min-w-0 space-y-3 rounded-xl p-4 text-sm" style={chatAgentSurfaceStyle}>
    <p className="font-semibold">Routine CLI in this private Chat</p>
    <p style={chatAgentMutedStyle}>Allow routine CLI proposals and controls for up to 30 minutes from verified owner-browser turns in this Chat.</p>
    {scope ? <div className="space-y-1 break-words">
      <p>Destination Bot <span className="break-all">{scope.target.botId}</span></p><p>Destination Chat <span className="break-all">{scope.target.chatId}</span></p>
      <p>View and propose routines; pause, resume and archive existing routines at this destination.</p>
      <p>{consent ? "Scope allowed until " : "Scope expires at "}<time dateTime={scope.expiresAt}>{new Date(scope.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>.</p>
    </div> : null}
    <p style={chatAgentMutedStyle}>{notice}</p>
    {status?.eligibility === "unavailable" ? <p role="status">Routine CLI verification is unavailable. Retry the explicit scope decision; per-operation confirmation still applies until a new browser turn is verified.</p> : null}
    {status?.eligibility === "target_required" ? <p>Choose a private Matrix Bot Chat in Chat Details before enabling routine CLI access.</p> : null}
    {!browserOrigin && !status && !controller.error ? <p role="status">Checking routine CLI access…</p> : null}
    {!browserOrigin ? <>
      <p>This device&apos;s turns still require per-operation confirmation. Finish routine operations in your owner browser for unattended Full Access.</p>
      {grantEnabled && controller.openOwnerBrowser ? <button type="button" className={primaryClass} disabled={busy || !status || status.eligibility === "ineligible" || status.eligibility === "target_required"} onClick={controller.openOwnerBrowser}>Continue in owner browser</button> : null}
    </> : !grantEnabled ? <p>Routine CLI consent is available for Claude in Full Access with the default interaction mode. Other harnesses keep per-operation confirmation.</p> : status?.eligibility === "eligible" || status?.eligibility === "unavailable" ? challenge && !consent ? <div className="flex flex-wrap gap-2">
      <button type="button" className={primaryClass} disabled={busy} onClick={() => controller.decide("approve")}>Allow routine CLI in this private Chat</button>
      <button type="button" className={controlClass} disabled={busy} onClick={() => controller.decide("decline")}>Decline</button>
    </div> : !consent ? <button type="button" className={controlClass} disabled={busy} onClick={controller.beginReview}>{status.eligibility === "unavailable" ? "Retry routine CLI access" : "Review routine CLI access"}</button> : <p role="status">This scope applies to new verified browser turns. It does not upgrade earlier requests.</p>
      : status?.eligibility === "target_required" ? null
        : status?.eligibility === "ineligible" ? <p>Routine CLI access is unavailable in this Chat.</p>
          : <p role="status">Checking routine CLI access…</p>}
    {busy ? <p role="status">Saving routine CLI access…</p> : null}
    {controller.error ? <p role="alert">{controller.error}</p> : null}
    <div className="flex flex-wrap gap-2">
      {consent || challenge ? <button type="button" className={controlClass} disabled={busy} onClick={controller.revoke}>Revoke routine CLI access</button> : null}
      <button type="button" className={controlClass} disabled={busy} onClick={() => void controller.refresh()}>Refresh status</button>
    </div>
  </section>;
}
/** The existing permission picker opens this explicit decision; selecting a mode grants nothing. */
export function RoutineFullAccessConsent({ controller, menuZIndex }: { controller: RoutineFullAccessController; menuZIndex?: number }) {
  if (!controller.visible) return null;
  return <Popover.Root open={controller.open} onOpenChange={controller.setOpen}>
    <Popover.Trigger asChild><button type="button" className="h-8 shrink-0 rounded-lg px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent))]" style={chatAgentMutedStyle} aria-label="Routine CLI access">Routine CLI</button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="end" sideOffset={8} collisionPadding={16} className="w-96 max-w-[calc(100vw-2rem)] outline-none" style={menuZIndex === undefined ? undefined : { zIndex: menuZIndex }}>
      <RoutineFullAccessConsentContent controller={controller}/>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
