"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AoedeCard, AoedeServerMessage } from "@matrix-os/contracts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useVocalStore } from "@/stores/vocal";
import { openProviderSettings } from "@/lib/canonical-provider-setup";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { CheckIcon, ChevronDownIcon, Loader2Icon, MicIcon, MicOffIcon, WrenchIcon, XIcon } from "@/lib/hugeicons";
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
  queued: "Queued", running: "Running", approval: "Needs your decision", done: "Done", failed: "Failed", cancelled: "Cancelled",
};

function TaskCard({ card, session, live }: { card: AoedeCard; session: SessionView; live: boolean }) {
  const deciding = session.deciding.includes(card.id);
  const disabled = !live || !session.connected || deciding;
  return <article className="aoede-task-attention" data-status={card.status}>
    <div className="aoede-task-heading">
      <h3>{card.approval?.title ?? card.title}</h3>
      {card.status === "approval" && <Button className="aoede-task-cancel" size="icon" variant="ghost"
        aria-label={`Cancel task: ${card.title}`} title={`Cancel: ${card.title}`} disabled={disabled}
        onClick={() => session.cancel(card)}><XIcon /></Button>}
    </div>
    <p className="aoede-task-status">{deciding ? "Confirming your decision…" : taskStates[card.status]}</p>
    {card.status === "approval" && card.approval && <>
      <p>{card.approval.description}</p>
      <div className="aoede-actions">
        {card.approval.allowedDecisions.includes("approve_once") && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void session.approval(card, "approve_once")}>Allow once</Button>}
        {card.approval.allowedDecisions.includes("deny") && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void session.approval(card, "deny")}>Deny</Button>}
      </div>
    </>}
  </article>;
}

function TaskActivity({ session, live }: { session: SessionView; live: boolean }) {
  const attention = session.cards.filter(card => card.status === "approval" || card.status === "failed");
  const tasks = session.cards.filter(card => card.status !== "approval" && card.status !== "failed");
  const running = tasks.some(card => card.status === "running");
  const count = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  return <section aria-label="Voice tasks" className="aoede-tasks" tabIndex={0}>
    {attention.length > 0 && <div className="aoede-task-alerts" aria-live="polite">
      {attention.map(card => <TaskCard key={card.id} card={card} session={session} live={live} />)}
    </div>}
    {tasks.length > 0 && <Collapsible className="aoede-task-disclosure">
      <CollapsibleTrigger className="aoede-task-trigger" aria-label={count}>
        {running ? <Loader2Icon className="aoede-task-spinner" aria-hidden="true" /> : <WrenchIcon aria-hidden="true" />}
        <span>{count}</span><ChevronDownIcon aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="aoede-task-details"><ul>{tasks.map(card =>
        <li key={card.id} className="aoede-task-row" data-status={card.status}>
          <span className="aoede-task-title" title={card.title}>{card.title}</span>
          <span className="aoede-task-state">
            {card.status === "done" ? <CheckIcon aria-hidden="true" />
              : card.status === "running" ? <Loader2Icon className="aoede-task-spinner" aria-hidden="true" />
              : card.status === "cancelled" ? <XIcon aria-hidden="true" /> : <WrenchIcon aria-hidden="true" />}
            <span>{taskStates[card.status]}</span>
          </span>
          <span className="aoede-task-cancel">
            {["queued", "running"].includes(card.status) && <Button size="icon" variant="ghost"
              aria-label={`Cancel task: ${card.title}`} title={`Cancel: ${card.title}`} disabled={!live || !session.connected}
              onClick={() => session.cancel(card)}><XIcon /></Button>}
          </span>
        </li>)}</ul></CollapsibleContent>
    </Collapsible>}
    {session.cards.length === 0 && <p className="aoede-empty">No actions yet.</p>}
    {session.taskErrors.map(error => <div className="aoede-notice" role="alert" key={`${error.sessionId}:${error.delegationId}`}>
      <h3>{error.outcome === "uncertain" ? "Task status is uncertain" : "Task did not start"}</h3>
      <p>{error.message}</p>
      {error.outcome === "uncertain" && <p>Check Chat before trying again. This task will not be retried automatically.</p>}
    </div>)}
    {session.recoveryError && <p className="aoede-notice" role="alert">Saved conversation could not be checked. Check Chat for existing work before asking Aoede to repeat it.</p>}
    {session.actionError && <p className="aoede-notice" role="alert">The action was not confirmed. Retry the same decision, or check the task in Chat before changing it.</p>}
  </section>;
}

function SessionControls({ session, live, end, confirmation }: {
  session: SessionView; live: boolean; end: () => void; confirmation: React.ReactNode;
}) {
  return <footer className="aoede-controls">
    <div className="aoede-session-actions" inert={!!confirmation}>
      <Button variant="secondary" aria-pressed={session.muted} disabled={session.status !== "active" || !session.connected} onClick={session.toggleMute}>
        {session.muted ? <MicOffIcon data-icon="inline-start" /> : <MicIcon data-icon="inline-start" />}{session.muted ? "Unmute" : "Mute"}
      </Button>
      {live ? <Button variant="ghost" onClick={end}>End session</Button>
        : <><Button disabled={!session.connected} onClick={() => void session.start()}>Fresh</Button>
          {session.resumeSessionId && <Button variant="ghost" disabled={!session.connected}
            onClick={() => void session.start(session.resumeSessionId!)}>Resume last conversation</Button>}</>}
      {live && session.playbackBlocked && <Button variant="secondary" onClick={() => void session.resumePlayback()}>Enable audio</Button>}
    </div>
    {confirmation}
    {!session.connected && <p role="status">Waiting for your computer to reconnect…</p>}
    <details className="aoede-privacy" inert={!!confirmation}><summary>Conversation &amp; privacy</summary>
      <p>Recent text is saved for up to 24 hours. No audio is stored. Chat history and remembered facts are kept separately.</p>
      <Button variant="ghost" onClick={() => void session.clearRecovery()}>Delete saved voice text</Button>
    </details>
  </footer>;
}

function voiceHint(session: SessionView, live: boolean) {
  if (session.playbackBlocked) return "Enable audio to hear Aoede, or end the voice session.";
  if (session.reconnecting) return "Reconnecting this voice session. Wait a moment, or end the session.";
  if (session.failure?.code === "denied" || session.status === "denied") return "Allow microphone access in your browser’s site permissions, then try again.";
  if (session.failure?.code === "device") return "Connect a working microphone, then try again.";
  if (session.failure?.code === "conflict") return "Another voice session is still being settled. Wait a moment, then try again.";
  if (session.failure?.code === "auth") return "Sign in again, then try voice.";
  if (session.failure?.code === "limited") return "Voice limit reached. Check Billing in Settings before trying again.";
  if (session.failure?.code === "unavailable") return "Voice service is unavailable. Try again shortly.";
  if (session.failure?.code === "playback") return "Audio could not play. Check your browser’s audio permissions, then try again.";
  if (session.failure?.code === "timeout" || session.failure?.phase === "transport") return "The voice connection could not be confirmed. Wait a moment before trying again.";
  if (session.status === "connecting") return session.phase === "microphone" ? "Allow microphone access to continue."
    : session.phase === "mint" ? "Starting your voice session…" : "Connecting voice audio…";
  if (session.status === "error") return "Voice could not connect. Try again shortly.";
  if (session.status === "active" && session.muted) return "Turn your microphone back on to continue.";
  if (live) return "You can interrupt anytime.";
  if (session.status === "idle") return "Start a session to speak with Aoede.";
  if (session.recoveryError) return "Start a fresh session when you’re ready. Previous conversation context may be unavailable.";
  return session.resumeSessionId ? "Fresh starts a new conversation. Resume restores the last conversation’s text and cards."
    : "Start a fresh conversation when you’re ready. Existing Chat work is kept separately.";
}

function VoicePresence({ session, active, live, audioRef }: {
  session: SessionView; active: boolean; live: boolean; audioRef: ReturnType<typeof useAoedeSession>["audioRef"];
}) {
  return <div className="aoede-presence">
    <AoedeOrb animate={active && live && !session.reconnecting && !session.playbackBlocked} connecting={session.status === "connecting" || session.reconnecting}
      muted={session.muted} inputStream={session.inputStream} audioRef={audioRef} />
    <h2 role="status">{session.reconnecting ? "Reconnecting…" : session.playbackBlocked ? "Audio needs permission"
      : session.status === "connecting" && session.phase === "microphone" ? "Waiting for microphone…"
      : session.muted && session.status === "active" ? "Microphone paused" : messages[session.status]}</h2>
    <p>{voiceHint(session, live)}</p>
  </div>;
}

export function AoedeOverlay({ active, onUi }: {
  active: boolean; onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult;
}) {
  const { audioRef, ...session } = useAoedeSession(active, onUi);
  const priorFocus = useRef<HTMLElement | null>(null);
  const openingSettings = useRef(false);
  const [intent, setIntent] = useState<"end" | "dismiss" | "settings" | null>(null);
  const confirmationOrigin = useRef<HTMLElement | null>(null);
  const ended = useRef(false);
  const keepTalking = useRef<HTMLButtonElement | null>(null);
  const focusKeepTalking = useCallback((node: HTMLButtonElement | null) => {
    keepTalking.current = node; node?.focus();
  }, []);
  const restoreConfirmationFocus = useRef(false);
  useLayoutEffect(() => {
    if (!intent && restoreConfirmationFocus.current) {
      restoreConfirmationFocus.current = false;
      if (active) confirmationOrigin.current?.focus();
    }
  }, [intent, active]);
  const live = session.status === "active" || session.status === "connecting";
  const dismiss = () => { useVocalStore.getState().setActive(false); };
  const request = (next: "end" | "dismiss" | "settings") => {
    if (live) {
      if (!intent) {
        ended.current = false;
        confirmationOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setIntent(next); keepTalking.current?.focus();
    } else if (next !== "end") { openingSettings.current = next === "settings"; dismiss(); }
  };
  const cancelEnd = () => { restoreConfirmationFocus.current = true; setIntent(null); };
  const confirmEnd = () => {
    if (ended.current) return;
    ended.current = true;
    session.stop("closed");
    openingSettings.current = intent === "settings";
    if (intent !== "end") dismiss();
    restoreConfirmationFocus.current = intent === "end";
    setIntent(null);
  };
  return <Dialog open={active} onOpenChange={(open) => { if (!open) request("dismiss"); }}>
    <DialogContent className="aoede-live ph-no-capture" showCloseButton={false} data-voice-state={session.status}
      style={{ zIndex: SHELL_Z_INDEX.voiceCompanion }}
      overlayStyle={{ zIndex: SHELL_Z_INDEX.voiceBackdrop, background: "#0d0c0ce0", backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" }}
      onEscapeKeyDown={(event) => { if (live || intent) { event.preventDefault(); if (intent) cancelEnd(); else request("dismiss"); } }}
      onInteractOutside={(event) => { if (live || intent) { event.preventDefault(); request("dismiss"); } }}
      onOpenAutoFocus={() => { ended.current = false; setIntent(null); openingSettings.current = false; priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // Radix calls this after removing its focus scope. Settings can now own focus.
        if (openingSettings.current) { openingSettings.current = false; openProviderSettings(); }
        else priorFocus.current?.focus();
      }}>
      <AoedeSurface animate={active && live} />
      <header className="aoede-header"><DialogHeader><DialogTitle>Aoede</DialogTitle>
        <DialogDescription className="sr-only">Voice conversation, actions, and transcript</DialogDescription></DialogHeader>
        <div className="aoede-header-actions">
          {session.readiness.status === "setup_required" && <Button className="aoede-access" variant="secondary" size="sm" onClick={() => request("settings")}>Connect harness</Button>}
          {["checking", "error"].includes(session.readiness.status) && <Button className="aoede-access" variant="ghost" size="sm"
            disabled={session.readiness.status === "checking"} title={session.readiness.status === "error" ? "Task access couldn’t be checked. Try again." : undefined}
            onClick={() => void session.refreshReadiness()}>{session.readiness.status === "checking" ? "Checking task access…" : "Check task access"}</Button>}
          <Button variant="ghost" size="icon" aria-label="Close Aoede" onClick={() => request("dismiss")}><XIcon /></Button>
        </div></header>
      <main className="aoede-body">
        <div className="aoede-presence-column">
          <VoicePresence session={session} active={active} live={live} audioRef={audioRef} />
          <TaskActivity session={session} live={live} />
          <SessionControls session={session} live={live} end={() => request("end")} confirmation={intent &&
            <div className="aoede-end-confirm" role="group" aria-label="End voice session?">
              <p>End voice session? Chat work continues and is not cancelled.</p>
              <div className="aoede-session-actions">
                <Button variant="secondary" ref={focusKeepTalking} onClick={cancelEnd}>Keep talking</Button>
                <Button variant="ghost" onClick={confirmEnd}>End voice session</Button>
              </div>
            </div>} />
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
