"use client";
import { useRef } from "react";
import type { AoedeCard, AoedeServerMessage } from "@matrix-os/contracts";
import { Button } from "@/components/ui/button";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useVocalStore } from "@/stores/vocal";
import { openProviderSettings } from "@/lib/canonical-provider-setup";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { CheckIcon, MicIcon, MicOffIcon, WrenchIcon, XIcon } from "@/lib/hugeicons";
import { useAoedeSession } from "./useAoedeSession";
import { AoedeOrb, AoedeSurface } from "./AoedeOrb";
import type { UiResult } from "./shell-actions";
import "./aoede.css";

const messages = {
  idle: "Ready to talk", connecting: "Connecting…", active: "Listening",
  closed: "Voice session ended", interrupted: "Your conversation was interrupted",
  superseded: "Voice moved to another session", error: "Voice is unavailable",
  denied: "Microphone access is blocked", caption_limit: "Conversation text limit reached",
};
type SessionView = Omit<ReturnType<typeof useAoedeSession>, "audioRef">;
const taskStates: Record<AoedeCard["status"], string> = {
  queued: "Queued", running: "Working in Chat", approval: "Needs your decision", done: "Done", failed: "Failed", cancelled: "Cancelled",
};

function TaskCard({ card, session, live }: { card: AoedeCard; session: SessionView; live: boolean }) {
  const deciding = session.deciding.includes(card.id);
  const disabled = !live || !session.connected || deciding;
  return <li className="aoede-task" data-status={card.status}>
    <div className="aoede-task-row">
      <WrenchIcon aria-hidden="true" />
      <h3>{card.approval?.title ?? card.title}</h3>
      <span className="aoede-task-state">{card.status === "done" && <CheckIcon aria-hidden="true" />}
        {card.status === "approval" && deciding ? "Confirming your decision…" : taskStates[card.status]}</span>
    </div>
    {card.status === "approval" && card.approval && <>
      <p>{card.approval.description}</p>
      <div className="aoede-actions">
        {card.approval.allowedDecisions.includes("approve_once") && <Button size="sm" disabled={disabled} onClick={() => void session.approval(card, "approve_once")}>Allow once</Button>}
        {card.approval.allowedDecisions.includes("deny") && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void session.approval(card, "deny")}>Deny</Button>}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => session.cancel(card)}>Cancel task</Button>
      </div>
    </>}
    {["queued", "running"].includes(card.status) && <Button size="sm" variant="ghost" disabled={!live || !session.connected}
      onClick={() => session.cancel(card)}>Cancel task</Button>}
  </li>;
}

function TaskActivity({ session, live, setup }: { session: SessionView; live: boolean; setup: () => void }) {
  return <section aria-label="Voice tasks" className="aoede-tasks" tabIndex={0}>
    <h2>Actions</h2>
    {session.cards.length ? <ul>{session.cards.map(card => <TaskCard key={card.id} card={card} session={session} live={live} />)}</ul>
      : <p className="aoede-empty">No actions yet.</p>}
    {session.readiness.status !== "ready" && <div className="aoede-notice" role="status">
      <h3>Task execution {session.readiness.status === "checking" ? "is being checked" : "needs attention"}</h3>
      <p>{session.readiness.message}</p>
      <p>Voice and task execution connect separately.</p>
      <div className="aoede-actions">
        {session.readiness.status === "setup_required" && <Button size="sm" onClick={setup}>Connect harness</Button>}
        <Button size="sm" variant="ghost" disabled={session.readiness.status === "checking"} onClick={() => void session.refreshReadiness()}>Recheck</Button>
      </div>
    </div>}
    {session.taskErrors.map(error => <div className="aoede-notice" role="alert" key={`${error.sessionId}:${error.delegationId}`}>
      <h3>{error.outcome === "uncertain" ? "Task status is uncertain" : "Task did not start"}</h3>
      <p>{error.message}</p>
      {error.outcome === "uncertain" && <p>Check Chat before trying again. This task will not be retried automatically.</p>}
    </div>)}
    {session.recoveryError && <p className="aoede-notice" role="alert">Saved conversation could not be checked. Check Chat for existing work before asking Aoede to repeat it.</p>}
    {session.actionError && <p className="aoede-notice" role="alert">The action was not confirmed. Retry the same decision, or check the task in Chat before changing it.</p>}
  </section>;
}

function SessionControls({ session, live }: { session: SessionView; live: boolean }) {
  return <footer className="aoede-controls">
    <div className="aoede-session-actions">
      <Button variant="secondary" aria-pressed={session.muted} disabled={session.status !== "active" || !session.connected} onClick={session.toggleMute}>
        {session.muted ? <MicOffIcon data-icon="inline-start" /> : <MicIcon data-icon="inline-start" />}{session.muted ? "Unmute" : "Mute"}
      </Button>
      {live ? <Button variant="ghost" onClick={() => session.stop("closed")}>End session</Button>
        : <Button disabled={!session.connected} onClick={session.start}>Start fresh session</Button>}
    </div>
    {!session.connected && <p role="status">Waiting for your computer to reconnect…</p>}
    <details className="aoede-privacy"><summary>Conversation &amp; privacy</summary>
      <p>Recent text is saved for up to 24 hours. No audio is stored. Chat history and remembered facts are kept separately.</p>
      <Button variant="ghost" onClick={() => void session.clearRecovery()}>Delete saved voice text</Button>
    </details>
  </footer>;
}

function voiceHint(session: SessionView, live: boolean) {
  if (session.status === "denied") return "Allow microphone access in your browser’s site permissions, then start a fresh session. No voice session was started.";
  if (session.status === "error") return "Check microphone access and try a fresh session.";
  if (session.status === "active" && session.muted) return "Turn your microphone back on to continue.";
  if (live) return "You can interrupt anytime.";
  if (session.status === "idle") return "Start a session to speak with Aoede.";
  if (session.recoveryError) return "Start a fresh session when you’re ready. Previous conversation context may be unavailable.";
  return "Start fresh with saved text and current Chat results. Recent speech may be missing; completed work will not be repeated.";
}

export function AoedeOverlay({ active, onUi }: {
  active: boolean; onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult;
}) {
  const { audioRef, ...session } = useAoedeSession(active, onUi);
  const priorFocus = useRef<HTMLElement | null>(null);
  const openingSettings = useRef(false);
  const dismiss = () => { session.stop("closed"); useVocalStore.getState().setActive(false); };
  const setup = () => {
    openingSettings.current = true;
    dismiss();
  };
  const live = session.status === "active" || session.status === "connecting";
  return <Dialog open={active} onOpenChange={(open) => { if (!open) dismiss(); }}>
    <DialogContent className="aoede-live ph-no-capture" showCloseButton={false} data-voice-state={session.status}
      style={{ zIndex: SHELL_Z_INDEX.voiceCompanion }}
      overlayStyle={{ zIndex: SHELL_Z_INDEX.voiceBackdrop, background: "#0d0c0ce0", backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" }}
      onOpenAutoFocus={() => { openingSettings.current = false; priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // Radix calls this after removing its focus scope. Settings can now own focus.
        if (openingSettings.current) { openingSettings.current = false; openProviderSettings(); }
        else priorFocus.current?.focus();
      }}>
      <AoedeSurface animate={active && live} />
      <header className="aoede-header"><DialogHeader><DialogTitle>Aoede</DialogTitle>
        <DialogDescription className="sr-only">Voice conversation, actions, and transcript</DialogDescription></DialogHeader>
        <Button variant="ghost" size="icon" aria-label="Close Aoede" onClick={dismiss}><XIcon /></Button></header>
      <main className="aoede-body">
        <div className="aoede-presence-column">
          <div className="aoede-presence">
            <AoedeOrb animate={active && live && !session.muted} />
            <h2 role="status">{session.muted && session.status === "active" ? "Microphone paused" : messages[session.status]}</h2>
            <p>{voiceHint(session, live)}</p>
          </div>
          <TaskActivity session={session} live={live} setup={setup} />
          <SessionControls session={session} live={live} />
        </div>
        <section className="aoede-conversation" aria-label="Conversation">
          <h2>Conversation</h2>
          <Conversation className="aoede-transcript" role="region" aria-label="Conversation transcript" initial="instant" resize="instant" tabIndex={0}>
            <ConversationContent className="aoede-transcript-content">
              {session.captions.length ? session.captions.map(caption => <div key={caption.id} className="aoede-message" data-role={caption.role}>
                <span>{caption.role === "user" ? "You" : "Aoede"}</span><p>{caption.text}</p>
              </div>) : <ConversationEmptyState className="aoede-transcript-empty" title="No conversation yet" description="Your conversation will appear here." />}
            </ConversationContent>
          </Conversation>
        </section>
      </main>
      {/* react-doctor-disable-next-line react-doctor/media-has-caption -- live WebRTC has no caption-file URL; provider transcript deltas are visible in the Conversation transcript region. */}
      <audio ref={audioRef} aria-hidden="true" />
    </DialogContent>
  </Dialog>;
}
