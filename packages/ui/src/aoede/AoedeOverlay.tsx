"use client";
import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import type { AoedeCard } from "@matrix-os/contracts";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { StickToBottom } from "use-stick-to-bottom";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { CheckIcon as CheckData, ChevronDownIcon as ChevronDownData, LoaderIcon as LoaderData,
  MicIcon as MicData, MicOffIcon as MicOffData, WrenchIcon as WrenchData, XIcon as XData } from "@hugeicons/core-free-icons";
import { cn } from "../cn.js";
import { GettingStartedBlocker } from "../getting-started-visibility.js";
import type { useAoedeSession } from "./useAoedeSession.js";
import { AoedeOrb, AoedeSurface } from "./AoedeOrb.js";
import "./aoede.css";

// These thin shell primitives retain the approved view's exact markup and classes.
// The package's native Dialog and matrix-styled Button have different semantics.
function Button({ className, variant = "default", size = "default", ...props }: ComponentProps<"button"> & {
  variant?: "default" | "secondary" | "ghost"; size?: "default" | "sm" | "icon";
}) {
  return <button data-slot="button" data-variant={variant} data-size={size}
    className={cn("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
      variant === "default" ? "bg-primary text-primary-foreground hover:bg-primary/90"
        : variant === "secondary" ? "bg-secondary text-secondary-foreground hover:bg-secondary/80" : "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
      size === "sm" ? "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5" : size === "icon" ? "size-9" : "h-9 px-4 py-2 has-[>svg]:px-3", className)} {...props} />;
}
const Dialog = DialogPrimitive.Root;
const DialogDescription = DialogPrimitive.Description;
function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className="text-lg leading-none font-semibold" {...props} />;
}
function DialogHeader(props: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className="flex flex-col gap-2 text-center sm:text-left" {...props} />;
}
function DialogContent({ overlayStyle, className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { overlayStyle: React.CSSProperties }) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" style={overlayStyle} />
    <DialogPrimitive.Content data-slot="dialog-content"
      className={cn("bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 outline-none sm:max-w-lg", className)} {...props}>
      <GettingStartedBlocker active />{children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
// Conversation source extracted from the shell's AI Elements component.
function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  return <StickToBottom className={cn("ph-no-capture relative flex-1 overflow-y-hidden", className)} initial="smooth" resize="smooth" role="log" {...props} />;
}
function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />;
}
function ConversationEmptyState({ className, title, description }: { className?: string; title: string; description: string }) {
  return <div className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)}>
    <div className="space-y-1"><h3 className="font-medium text-sm">{title}</h3><p className="text-muted-foreground text-sm">{description}</p></div>
  </div>;
}
function createIcon(icon: IconSvgElement) {
  return function Icon({ size = 24, strokeWidth = 1.5, ...props }: Omit<ComponentProps<typeof HugeiconsIcon>, "icon">) {
    return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} {...props} />;
  };
}
const CheckIcon = createIcon(CheckData), ChevronDownIcon = createIcon(ChevronDownData), Loader2Icon = createIcon(LoaderData);
const MicIcon = createIcon(MicData), MicOffIcon = createIcon(MicOffData), WrenchIcon = createIcon(WrenchData), XIcon = createIcon(XData);

// Preserve the shell's voice band: above chrome (650), below Settings (700).
const voiceLayer = { backdrop: 660, companion: 665 };

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

function voiceHint(session: SessionView, live: boolean, permissionSurface: "browser" | "desktop") {
  if (session.playbackBlocked) return "Enable audio to hear Aoede, or end the voice session.";
  if (session.reconnecting) return "Reconnecting this voice session. Wait a moment, or end the session.";
  if (session.failure?.code === "denied" || session.status === "denied") return permissionSurface === "desktop"
    ? "Allow Matrix OS microphone access in your system’s microphone permissions, then try again."
    : "Allow microphone access in your browser’s site permissions, then try again.";
  if (session.failure?.code === "device") return "Connect a working microphone, then try again.";
  if (session.failure?.code === "conflict") return "Another voice session is still being settled. Wait a moment, then try again.";
  if (session.failure?.code === "auth") return "Sign in again, then try voice.";
  if (session.failure?.code === "limited") return "Voice limit reached. Check Billing in Settings before trying again.";
  if (session.failure?.code === "unavailable") return "Voice service is unavailable. Try again shortly.";
  if (session.failure?.code === "playback") return permissionSurface === "desktop"
    ? "Audio could not play. Check your computer’s audio output, then try again."
    : "Audio could not play. Check your browser’s audio permissions, then try again.";
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

function VoicePresence({ session, active, live, audioRef, permissionSurface }: {
  session: SessionView; active: boolean; live: boolean; audioRef: ReturnType<typeof useAoedeSession>["audioRef"];
  permissionSurface: "browser" | "desktop";
}) {
  return <div className="aoede-presence">
    <AoedeOrb animate={active && live && !session.reconnecting && !session.playbackBlocked} connecting={session.status === "connecting" || session.reconnecting}
      muted={session.muted} inputStream={session.inputStream} audioRef={audioRef} />
    <h2 role="status">{session.reconnecting ? "Reconnecting…" : session.playbackBlocked ? "Audio needs permission"
      : session.status === "connecting" && session.phase === "microphone" ? "Waiting for microphone…"
      : session.muted && session.status === "active" ? "Microphone paused" : messages[session.status]}</h2>
    <p>{voiceHint(session, live, permissionSurface)}</p>
  </div>;
}

export type AoedeOverlayViewProps = {
  active: boolean;
  session: ReturnType<typeof useAoedeSession>;
  onDismiss: () => void;
  onOpenSettings: () => void;
  permissionSurface?: "browser" | "desktop";
};
export function AoedeOverlayView({ active, session, onDismiss, onOpenSettings, permissionSurface = "browser" }: AoedeOverlayViewProps) {
  const { audioRef } = session;
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
  const dismiss = onDismiss;
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
    <DialogContent className="aoede-live ph-no-capture" data-voice-state={session.status}
      style={{ zIndex: voiceLayer.companion }}
      overlayStyle={{ zIndex: voiceLayer.backdrop, background: "#0d0c0ce0", backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" }}
      onEscapeKeyDown={(event) => { if (live || intent) { event.preventDefault(); if (intent) cancelEnd(); else request("dismiss"); } }}
      onInteractOutside={(event) => { if (live || intent) { event.preventDefault(); request("dismiss"); } }}
      onOpenAutoFocus={() => { ended.current = false; setIntent(null); openingSettings.current = false; priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // Radix calls this after removing its focus scope. Settings can now own focus.
        if (openingSettings.current) { openingSettings.current = false; onOpenSettings(); }
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
          <VoicePresence session={session} active={active} live={live} audioRef={audioRef} permissionSurface={permissionSurface} />
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
