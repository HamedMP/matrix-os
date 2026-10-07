"use client";
import { useEffect, useRef } from "react";
import type { AoedeCard, AoedeServerMessage } from "@matrix-os/contracts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useVocalStore } from "@/stores/vocal";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { CheckIcon, ChevronDownIcon, Loader2Icon, WrenchIcon, XIcon } from "@/lib/hugeicons";
import { useAoedeSession } from "./useAoedeSession";
import type { UiResult } from "./shell-actions";
import "./aoede.css";

const messages = {
  idle: "A little space to think out loud", connecting: "Connecting…", active: "Listening · You can interrupt anytime",
  closed: "Voice session ended", interrupted: "Your conversation was interrupted",
  superseded: "Voice moved to another session", error: "Voice is unavailable. Check microphone access and try again.",
  denied: "Microphone access is blocked",
  caption_limit: "This conversation reached its text limit. Your captions are still here.",
};
type SessionView = Omit<ReturnType<typeof useAoedeSession>, "audioRef">;
const taskStates: Record<AoedeCard["status"], string> = {
  queued: "Queued", running: "Running", approval: "Needs your decision", done: "Done", failed: "Failed", cancelled: "Cancelled",
};
function TaskCard({ card, session, live }: { card: AoedeCard; session: SessionView; live: boolean }) {
  const deciding = session.deciding.includes(card.id);
  const disabled = !live || !session.connected || deciding;
  return <article className="aoede-task-attention" data-status={card.status}>
    <h3>{card.approval?.title ?? card.title}</h3>
    <p className="aoede-task-status">{card.status === "approval" && deciding ? "Confirming your decision…" : taskStates[card.status]}</p>
    {card.status === "approval" && card.approval && <><p className="aoede-task-description">{card.approval.description}</p><div className="aoede-actions">
      {card.approval.allowedDecisions.includes("approve_once") && <Button size="sm" disabled={disabled} onClick={() => void session.approval(card, "approve_once")}>Allow once</Button>}
      {card.approval.allowedDecisions.includes("deny") && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void session.approval(card, "deny")}>Deny</Button>}
      <Button size="sm" variant="ghost" disabled={!live || !session.connected} onClick={() => session.cancel(card)}>Cancel task</Button>
    </div></>}
  </article>;
}
function TaskActivity({ session, live }: { session: SessionView; live: boolean }) {
  const attention = session.cards.filter(card => card.status === "approval" || card.status === "failed");
  const tasks = session.cards.filter(card => card.status !== "approval" && card.status !== "failed");
  const count = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  return <section aria-label="Voice tasks" className="aoede-tasks">
    {attention.length > 0 && <div className="aoede-task-alerts" aria-live="polite">
      {attention.map(card => <TaskCard key={card.id} card={card} session={session} live={live} />)}
    </div>}
    {tasks.length > 0 && <Collapsible className="aoede-task-disclosure">
      <CollapsibleTrigger className="aoede-task-trigger" aria-label={count}>
        <WrenchIcon aria-hidden="true" /><span>{count}</span><ChevronDownIcon aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="aoede-task-details"><ul>{tasks.map(card => <li key={card.id} className="aoede-task-row" data-status={card.status}>
        <span className="aoede-task-title" title={card.title}>{card.title}</span>
        <span className="aoede-task-state">
          {card.status === "done" ? <CheckIcon aria-hidden="true" />
            : card.status === "running" ? <Loader2Icon aria-hidden="true" />
            : card.status === "cancelled" ? <XIcon aria-hidden="true" /> : <WrenchIcon aria-hidden="true" />}
          <span>{taskStates[card.status]}</span>
        </span>
        <span className="aoede-task-cancel">
          {["queued", "running"].includes(card.status) && <Button size="icon" variant="ghost" aria-label="Cancel task"
            title={`Cancel: ${card.title}`} disabled={!live || !session.connected} onClick={() => session.cancel(card)}><XIcon /></Button>}
        </span>
      </li>)}</ul></CollapsibleContent>
    </Collapsible>}
  </section>;
}
function ConversationControls({ session, live }: { session: SessionView; live: boolean }) {
  return <footer className="aoede-footer"><div className="aoede-actions">
    {!live && <Button disabled={!session.connected} onClick={session.start}>Start fresh session</Button>}
    {live && <Button variant="outline" onClick={() => session.stop("closed")}>End session</Button>}
    {!session.connected && <p role="status">Waiting for your computer to reconnect…</p>}
  </div><details className="aoede-conversation"><summary>Conversation &amp; privacy</summary><div className="aoede-conversation-panel">
    {session.captions.length > 0 && <section aria-label="Full conversation captions" className="aoede-transcript" tabIndex={0}>{session.captions.map((caption) =>
      <p key={caption.id}><strong>{caption.role === "user" ? "You" : "Aoede"}</strong> {caption.text}</p>)}</section>}
    <p className="aoede-recovery">Recent text is saved for up to 24 hours. No audio is stored. Chat history and remembered facts are kept separately.</p>
    <Button variant="ghost" onClick={() => void session.clearRecovery()}>Delete saved voice text</Button>
  </div></details></footer>;
}
function VoiceCaptions({ captions, live }: { captions: SessionView["captions"]; live: boolean }) {
  const captionRef = useRef<HTMLElement | null>(null);
  const follow = useRef(true);
  const latest = captions.at(-1);
  useEffect(() => {
    if (follow.current && captionRef.current) captionRef.current.scrollTop = captionRef.current.scrollHeight;
  }, [latest]);
  const role = latest?.role === "user" ? "You" : "Aoede";
  const previousRole = latest?.role === "user" ? "Previous request" : "Previous response";
  return <section ref={captionRef} aria-label="Voice captions" className="aoede-captions" tabIndex={latest ? 0 : undefined}
    onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; }}>
    {latest ? <p><strong>{live ? role : previousRole}</strong>{latest.text}</p>
      : <p>{live ? "Speak naturally. There’s nothing to press." : "Open an app, take a note, or work on something together."}</p>}
  </section>;
}
function useOrbMeter(active: boolean, status: SessionView["status"], inputStream: SessionView["inputStream"]) {
  const orbRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const orb = orbRef.current;
    if (!active || status !== "active" || !orb || typeof AudioContext === "undefined"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stream = inputStream();
    if (!stream) return;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
    } catch (error) {
      console.warn("[aoede] Orb metering unavailable:", error instanceof Error ? error.name : "UnknownError");
      void context?.close().catch((failure: unknown) => console.warn("[aoede] Orb metering cleanup unavailable:", failure instanceof Error ? failure.name : "UnknownError"));
      return;
    }
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0, previous = 0, lastSample = 0;
    const update = (time: number) => {
      if (time - lastSample >= 40) {
        lastSample = time;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        // Reuse the previous Aoede orb's immediate attack and soft release.
        const target = Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.8);
        previous = target >= previous ? target : previous * .72 + target * .28;
        orb.style.setProperty("--aoede-level", previous.toFixed(3));
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    void context.resume().catch((error: unknown) => console.warn("[aoede] Orb metering unavailable:", error instanceof Error ? error.name : "UnknownError"));
    return () => {
      cancelAnimationFrame(frame); source.disconnect(); analyser.disconnect();
      orb.style.setProperty("--aoede-level", "0");
      void context?.close().catch((error: unknown) => console.warn("[aoede] Orb metering cleanup unavailable:", error instanceof Error ? error.name : "UnknownError"));
    };
  }, [active, status, inputStream]);
  return orbRef;
}
export function AoedeOverlay({ active, onUi }: {
  active: boolean; onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult;
}) {
  const { audioRef, ...session } = useAoedeSession(active, onUi);
  const priorFocus = useRef<HTMLElement | null>(null);
  const orbRef = useOrbMeter(active, session.status, session.inputStream);
  const dismiss = () => { session.stop("closed"); useVocalStore.getState().setActive(false); };
  const live = session.status === "active" || session.status === "connecting";
  return <Dialog open={active} onOpenChange={(open) => { if (!open) dismiss(); }}>
    <DialogContent className="aoede-live ph-no-capture" showCloseButton={false}
      data-state={session.status}
      style={{ zIndex: SHELL_Z_INDEX.voiceCompanion }}
      overlayStyle={{ zIndex: SHELL_Z_INDEX.voiceBackdrop, background: "rgba(3, 4, 10, .92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      onOpenAutoFocus={() => { priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => { event.preventDefault(); priorFocus.current?.focus(); }}>
      <header className="aoede-header"><DialogHeader><DialogTitle>Aoede</DialogTitle><DialogDescription>Voice preview</DialogDescription></DialogHeader>
        <Button variant="ghost" size="icon" aria-label="Close Aoede" onClick={dismiss}><XIcon /></Button></header>
      <main className="aoede-stage">
      <div className="aoede-presence" data-live={session.status === "active"} data-captioning={session.captioning}>
        <div ref={orbRef} className="aoede-orb" aria-hidden="true"><span className="aoede-orb-glow" /><span className="aoede-orb-ring" />
          <span className="aoede-orb-core"><span className="aoede-orb-blob aoede-orb-a" /><span className="aoede-orb-blob aoede-orb-b" /><span className="aoede-orb-blob aoede-orb-c" /><span className="aoede-orb-glass" /></span></div>
        <p role="status">{session.status === "active" && session.captioning ? "Aoede · Microphone still on" : messages[session.status]}</p>
      </div>
      <VoiceCaptions captions={session.captions} live={live} />
      {session.cards.length > 0 && <TaskActivity session={session} live={live} />}
      {session.actionError && <p className="aoede-recovery" role="alert">The action was not confirmed. Retry the same decision, or check the task in Chat before changing it.</p>}
      {session.status === "denied" && <p className="aoede-recovery">Allow microphone access in your browser’s site permissions, then start a fresh session. No voice session was started.</p>}
      {!live && !["idle", "denied"].includes(session.status) && <p className="aoede-recovery">Start fresh with saved text and current Chat results. Recent speech may be missing; completed work will not be repeated.</p>}
      </main>
      <ConversationControls session={session} live={live} />
      {/* react-doctor-disable-next-line react-doctor/media-has-caption -- live WebRTC has no caption-file URL: provider transcript deltas are displayed in the Voice captions region above; this hidden element only plays its media track. */}
      <audio ref={audioRef} aria-hidden="true" />
    </DialogContent>
  </Dialog>;
}
