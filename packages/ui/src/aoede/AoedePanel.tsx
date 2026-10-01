"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SafeVoiceError, VoiceCapability } from "@matrix-os/contracts/voice-session";
import { Button } from "../Button.js";
import {
  AOEDE_STATUS_LABELS, aoedeActionCopy, aoedeErrorCopy, aoedeReadinessCopy,
  boundedAoedeText, type AoedeStatus,
} from "./presentation.js";
import { orbLevel } from "./orb-level.js";
import { AoedeCloseIcon, AoedeHistoryIcon, AoedeNewIcon, AoedeSettingsIcon } from "./icons.js";
import "./aoede-panel.css";

export interface AoedePanelProps {
  title?: string;
  scopeLabel: string;
  status: AoedeStatus;
  microphoneActive: boolean;
  turnMode: "hands_free" | "push_to_talk";
  captions: { utterance?: string; response?: string; provisional?: boolean };
  capability?: VoiceCapability;
  /** Canonical run-cancellation support; when provided, the Cancel generation control is gated on it. */
  canCancel?: boolean;
  error?: SafeVoiceError;
  children?: ReactNode;
  commands: {
    start(): void;
    dismiss(): void;
    end(): void;
    pause(): void;
    resume(): void;
    stopSpeaking(): void;
    cancelGeneration?(): void;
    pushToTalkStart(): void;
    pushToTalkStop(): void;
    retry(): void;
    newConversation(): void;
    viewHistory?(): void;
  };
  settings?: ReactNode;
  /**
   * Capture loudness feed (0…1) for the presence orb. Called outside React
   * state: the panel writes a CSS custom property imperatively so ~20
   * updates/s never re-render the panel.
   */
  subscribeInputLevel?: (listener: (level: number) => void) => () => void;
  /**
   * Host-provided renderer for the assistant's response text (markdown). The
   * panel bounds the text first; the host decides how it is displayed.
   */
  renderResponse?: (text: string) => ReactNode;
}

/** Presentation only. The host owns focus restoration, light dismissal, media and canonical work. */
export function AoedePanel({
  title = "Aoede", scopeLabel, status, microphoneActive, turnMode, captions,
  capability, canCancel, error, children, commands, settings, subscribeInputLevel, renderResponse,
}: AoedePanelProps) {
  const id = useId();
  const orb = useRef<HTMLDivElement | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const listening = status === "listening" && microphoneActive;
  useEffect(() => {
    const node = orb.current;
    if (!node) return;
    if (!listening || !subscribeInputLevel) { node.style.setProperty("--aoede-level", "0"); return; }
    let level = 0;
    const unsubscribe = subscribeInputLevel((rms) => {
      level = orbLevel(level, rms);
      node.style.setProperty("--aoede-level", level.toFixed(3));
    });
    return () => { unsubscribe(); node.style.setProperty("--aoede-level", "0"); };
  }, [listening, subscribeInputLevel]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [held, setHeld] = useState(false);
  // An input gesture, not session state. Retain the stop paired with its start across prop changes.
  const hold = useRef<{ key?: string; pointerId?: number; stop(): void } | null>(null);
  const release = useCallback(() => {
    const gesture = hold.current;
    if (!gesture) return;
    hold.current = null;
    setHeld(false);
    gesture.stop();
  }, []);
  const active = status === "listening" || status === "thinking" || status === "using_tool" || status === "speaking";
  // Only "available" may create or reconnect a session; "degraded" is display-only.
  const ready = capability?.status === "available";
  const modeAvailable = ready && Boolean(capability?.turnModes.includes(turnMode));
  const canHold = modeAvailable && turnMode === "push_to_talk" && active;

  useEffect(() => {
    if (!canHold) release();
  }, [canHold, release]);

  useEffect(() => {
    const onHidden = () => { if (document.hidden) release(); };
    const onPointerRelease = (event: PointerEvent) => {
      if (hold.current && hold.current.key === undefined && hold.current.pointerId === event.pointerId) release();
    };
    const onKeyRelease = (event: KeyboardEvent) => {
      if (hold.current?.key === event.key) release();
    };
    window.addEventListener("blur", release);
    window.addEventListener("pointerup", onPointerRelease);
    window.addEventListener("pointercancel", onPointerRelease);
    window.addEventListener("keyup", onKeyRelease);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      window.removeEventListener("keyup", onKeyRelease);
      document.removeEventListener("visibilitychange", onHidden);
      release();
    };
  }, [release]);

  const utterance = boundedAoedeText(captions.utterance);
  const response = boundedAoedeText(captions.response);
  // Keep the newest exchange in view as it streams; the region itself never resizes.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [utterance, response, children, error]);

  const begin = (gesture: { key?: string; pointerId?: number }) => {
    if (!canHold || hold.current) return;
    hold.current = { ...gesture, stop: commands.pushToTalkStop };
    setHeld(true);
    commands.pushToTalkStart();
  };
  const afterRelease = (command: () => void) => () => { release(); command(); };
  const displayTitle = boundedAoedeText(title, 80) || "Aoede";
  const actionCopy = aoedeActionCopy(capability);
  const canStart = status === "idle" || status === "ended";
  // Fail closed: an omitted canCancel means "not qualified", never "show it
  // anyway". When canonical children render, the CancellationCard inside owns
  // the affordance — the built-in button is the fallback for card-free panels.
  const showCancel = Boolean(commands.cancelGeneration) && active && status !== "listening"
    && canCancel === true && !children;
  const canRetry = status === "failed" && error?.retryable && error.code !== "chat_unavailable";
  const showError = status === "failed" || Boolean(error);
  const transcriptEmpty = !utterance && !response && !children && !showError;

  return (
    <section className="matrix-aoede" aria-labelledby={`${id}-title`} data-state={status}>
      <header className="matrix-aoede__header">
        <h2 id={`${id}-title`}>{displayTitle}</h2>
        <div className="matrix-aoede__tools" role="group" aria-label="Conversation">
          <Button variant="ghost" size="icon" className="matrix-aoede__icon" aria-label="New conversation"
            title="New conversation" onClick={afterRelease(commands.newConversation)}><AoedeNewIcon /></Button>
          {commands.viewHistory ? <Button variant="ghost" size="icon" className="matrix-aoede__icon" aria-label="View history"
            title="View history" onClick={commands.viewHistory}><AoedeHistoryIcon /></Button> : null}
          {settings ? <Button variant="ghost" size="icon" className="matrix-aoede__icon" aria-label="Settings" title="Settings"
            aria-expanded={settingsOpen} aria-controls={`${id}-settings`}
            onClick={() => setSettingsOpen((open) => !open)}><AoedeSettingsIcon /></Button> : null}
          <Button variant="ghost" size="icon" className="matrix-aoede__icon" title="Dismiss"
            aria-label={`Dismiss ${displayTitle}`} onClick={afterRelease(commands.dismiss)}><AoedeCloseIcon /></Button>
        </div>
      </header>

      <div className="matrix-aoede__presence">
        <div ref={orb} className="matrix-aoede__orb" data-testid="aoede-orb" aria-hidden="true">
          <span className="matrix-aoede__orb-glow" />
          <span className="matrix-aoede__orb-ring" />
          <span className="matrix-aoede__orb-blob matrix-aoede__orb-blob--a" />
          <span className="matrix-aoede__orb-blob matrix-aoede__orb-blob--b" />
          <span className="matrix-aoede__orb-blob matrix-aoede__orb-blob--c" />
          <span className="matrix-aoede__orb-glass" />
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" className="matrix-aoede__status">
          <p className="matrix-aoede__literal">{AOEDE_STATUS_LABELS[status]}</p>
          <p className="matrix-aoede__meta">
            <span className="matrix-aoede__mic" data-active={microphoneActive}>{microphoneActive ? "Microphone active" : "Microphone off"}</span>
            <span className="matrix-aoede__scope">{boundedAoedeText(scopeLabel, 160)}</span>
          </p>
        </div>
      </div>

      {settings && settingsOpen ? (
        <section id={`${id}-settings`} className="matrix-aoede__settings" aria-label="Aoede settings">{settings}</section>
      ) : (
        <div ref={transcript} className="matrix-aoede__transcript" data-empty={transcriptEmpty}>
          {canStart && transcriptEmpty ? <p id={`${id}-rationale`} className="matrix-aoede__rationale">
            Start turns on the microphone and listens for your next turn. Pause, Dismiss or End turns it off.
          </p> : null}
          {utterance ? <section className="matrix-aoede__caption matrix-aoede__caption--you"
            aria-label={captions.provisional ? "Current utterance (provisional)" : "Current utterance"}>
            <h3>{captions.provisional ? "Provisional utterance" : "You"}</h3><p>{utterance}</p>
          </section> : null}
          {response ? <section className="matrix-aoede__caption matrix-aoede__caption--assistant" aria-label="Current response">
            <h3>{displayTitle}</h3>
            {renderResponse ? <div className="matrix-aoede__response">{renderResponse(response)}</div> : <p>{response}</p>}
          </section> : null}
          {children ? <div className="matrix-aoede__canonical">{children}</div> : null}
          {showError ? <p className="matrix-aoede__error" role="alert" aria-live="assertive">
            {aoedeErrorCopy(error?.code)}
          </p> : null}
        </div>
      )}

      <div className="matrix-aoede__readiness">
        <p>{aoedeReadinessCopy(capability, status)}</p>
        {actionCopy ? <p>{actionCopy}</p> : null}
      </div>

      <div role="group" aria-label="Aoede controls" className="matrix-aoede__controls">
        {canStart ? <Button className="matrix-aoede__button matrix-aoede__button--main" disabled={!modeAvailable}
          aria-describedby={transcriptEmpty ? `${id}-rationale` : undefined} onClick={commands.start}>Start</Button> : null}
        {canHold ? <Button className="matrix-aoede__button matrix-aoede__button--main matrix-aoede__ptt" aria-pressed={held}
          aria-describedby={`${id}-ptt-hint`}
          onPointerDown={(event) => {
            if (event.button !== undefined && event.button !== 0) return;
            if (hold.current) return;
            begin({ pointerId: event.pointerId });
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerUp={(event) => { if (hold.current?.pointerId === event.pointerId && hold.current?.key === undefined) release(); }}
          onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
          onKeyDown={(event) => {
            if (event.key === "Escape") { release(); return; }
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (!event.repeat) begin({ key: event.key });
          }}
          onKeyUp={(event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (hold.current?.key === event.key) release();
          }}
          onClick={(event) => {
            // Assistive technology synthesizes clicks without pointer/key hold events.
            if (event.detail === 0) { if (hold.current) release(); else begin({}); }
          }}>Push to talk</Button> : null}
        {active ? <Button variant="secondary" className="matrix-aoede__button" onClick={afterRelease(commands.pause)}>Pause</Button> : null}
        {status === "paused" ? <Button className="matrix-aoede__button matrix-aoede__button--main" disabled={!modeAvailable} onClick={commands.resume}>Resume</Button> : null}
        {status === "speaking" ? <Button variant="secondary" className="matrix-aoede__button" onClick={commands.stopSpeaking}>Stop speaking</Button> : null}
        {showCancel && commands.cancelGeneration ? <Button variant="secondary" className="matrix-aoede__button" onClick={afterRelease(commands.cancelGeneration)}>Cancel generation</Button> : null}
        {canRetry ? <Button className="matrix-aoede__button matrix-aoede__button--main" onClick={afterRelease(commands.retry)}>Retry</Button> : null}
        {!canStart ? <Button variant="secondary" className="matrix-aoede__button" onClick={afterRelease(commands.end)}>End</Button> : null}
      </div>
      {canHold ? <p id={`${id}-ptt-hint`} className="matrix-aoede__hint">Hold to speak. Release to send. Use Space or Enter on the button.</p> : null}
    </section>
  );
}
