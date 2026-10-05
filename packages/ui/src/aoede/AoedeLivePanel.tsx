"use client";
import "./aoede-live.css";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { desktopPalette, fonts, onboardingChecklist, palette } from "@matrix-os/brand/tokens";
import { rabbitMarkSvg } from "@matrix-os/brand/marks";
import { SHELL_Z_INDEX, DESKTOP_Z_INDEX } from "../shell-layering.js";
import type { AoedePanelProps } from "./AoedePanel.js";
import { aoedeErrorCopy, aoedeReadinessCopy, AOEDE_STATUS_LABELS, boundedAoedeText } from "./presentation.js";
import { minusIcon, expandIcon, micIcon, sendIcon } from "./widget-icons.js";

const rabbit = `data:image/svg+xml,${encodeURIComponent(rabbitMarkSvg('matrix-mark').replace('currentColor', 'white'))}`;
/** Compact canonical chat follows the approved onboarding widget. Voice adds a
 * pointer-transparent edge halo; readiness never changes the presentation.
 */
export function AoedeLivePanel(props: AoedePanelProps & { pushToTalkControl?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [textError, setTextError] = useState(false);
  const alive = useRef(true);
  const draftRevision = useRef(0);
  const sendingRef = useRef(false);
  const conversation = useRef<HTMLElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { conversation.current?.focus(); }, [props.focusRevision]);
  const active = !["idle", "ended", "failed"].includes(props.status);
  const ready = props.capability?.status === "available" && props.capability.turnModes.includes(props.turnMode);
  const style = { zIndex: (props.surface ?? props.capability?.surface) === "electron_desktop" ? DESKTOP_Z_INDEX.voiceCompanion : SHELL_Z_INDEX.voiceCompanion,
    "--live-forest": desktopPalette.forest, "--live-paper": desktopPalette.paper,
    "--live-gold": desktopPalette.gold, "--live-coral": desktopPalette.coral, "--live-blue": desktopPalette.blue,
    "--live-serif": fonts.display, "--live-sans": fonts.ui,
    "--live-widget": onboardingChecklist.colors.surface, "--live-border": onboardingChecklist.colors.border,
    "--live-ink": palette.surfaceInverse, "--live-muted": desktopPalette.textMuted,
  } as CSSProperties;
  const submit = async () => {
    if (sendingRef.current || !props.canSendText || !props.commands.sendText || !draft.trim()) return;
    const revision = draftRevision.current;
    sendingRef.current = true; setSending(true); setTextError(false);
    try {
      const accepted = await props.commands.sendText(draft);
      if (!alive.current) return;
      if (accepted && draftRevision.current === revision) setDraft("");
      if (!accepted) setTextError(true);
    } catch (error: unknown) {
      console.warn("[aoede] message unavailable", error instanceof Error ? error.name : "UnknownError");
      if (alive.current) setTextError(true);
    } finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  return <div data-aoede-live className="matrix-aoede-live" data-state={props.status} style={style}>
    {active ? <div className="matrix-aoede-live__halo" aria-hidden="true" /> : null}
    <section ref={conversation} tabIndex={-1} role="dialog" aria-modal="false" className="matrix-aoede-live__conversation" aria-label="Aoede live conversation" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); props.commands.dismiss(); }
    }}>
      <header className="matrix-aoede-live__header">
        <span className="matrix-aoede-live__avatar"><img src={rabbit} alt="" /></span>
        <strong>Matrix</strong>
        <button type="button" aria-label="More options" aria-expanded={more} onClick={() => setMore(v => !v)}>···</button>
        <button type="button" aria-label="Dismiss Aoede" onClick={props.commands.dismiss}><img src={minusIcon} alt="" /></button>
        <button type="button" aria-label="Expand conversation" disabled={!props.commands.viewHistory} onClick={props.commands.viewHistory}><img src={expandIcon} alt="" /></button>
      </header>
      <div className="matrix-aoede-live__body">
        <div className="matrix-aoede-live__meta"><span role="status">{props.capability || active ? AOEDE_STATUS_LABELS[props.status] : props.status === "failed" ? "Connection unavailable" : "Connecting"}</span><span>{boundedAoedeText(props.scopeLabel, 160)}</span></div>
        <div className="matrix-aoede-live__captions" aria-live="polite" aria-atomic="false">
          {props.captions.utterance ? <p><span>You</span>{boundedAoedeText(props.captions.utterance)}</p> : null}
          {props.captions.response ? <div role="region" aria-label="Current response" className="matrix-aoede-live__response"><span>Matrix{props.captions.interrupted ? " · interrupted" : ""}</span>{props.renderResponse?.(boundedAoedeText(props.captions.response)) ?? boundedAoedeText(props.captions.response)}</div> : null}
          {!props.captions.utterance && !props.captions.response && props.status !== "failed" ? <p>{props.capability ? "What would you like to do?" : "Connecting to your workspace…"}</p> : null}
        </div>
        {props.error ? <p className="matrix-aoede-live__error" role="alert">{aoedeErrorCopy(props.error.code)}</p> : null}
        {!active ? <p className="matrix-aoede-live__readiness">{aoedeReadinessCopy(props.capability, props.status)}</p> : null}
        <div role="group" aria-label="Aoede controls" className="matrix-aoede-live__controls">
          {props.pushToTalkControl}
          {!active ? <button type="button" disabled={!ready} onClick={props.commands.start}>Start talking</button> : null}
          {active ? <button type="button" onClick={props.status === "paused" ? props.commands.resume : props.commands.pause}>{props.status === "paused" ? "Unmute" : "Mute"}</button> : null}
          {props.status === "speaking" ? <button type="button" onClick={props.commands.stopSpeaking}>Stop speaking</button> : null}
          {props.status === "failed" && props.error?.retryable ? <button type="button" onClick={props.commands.retry}>Retry</button> : null}
          {active ? <button type="button" onClick={props.commands.end}>End voice</button> : null}
        </div>
        <div className="matrix-aoede-live__options" hidden={!more}>
          <button type="button" onClick={() => { setSettings(false); setExpanded(v => !v); }} aria-expanded={expanded}>Context & tasks</button>
          <button type="button" onClick={props.commands.viewHistory}>Chat history</button>
          <button type="button" onClick={props.commands.newConversation} disabled={props.status === "ending" || sending}>New conversation</button>
          <button type="button" onClick={() => { setSettings(v => !v); setExpanded(true); }}>Settings</button>
        </div>
        <div className="matrix-aoede-live__context" hidden={!expanded}>
          {settings ? props.settings : null}
          <div hidden={settings}>{props.children}</div>
          <p>Voice ends capture and playback. Authorized tasks continue in Chat.</p>
        </div>
        {textError ? <p role="alert" className="matrix-aoede-live__error">Your message could not be sent. Your draft is saved here; retry the same message.</p> : null}
      </div>
      <form className="matrix-aoede-live__composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <input aria-label="Message Matrix" placeholder="Or type what you need…" value={draft} maxLength={8000} disabled={!props.canSendText}
          onChange={event => { draftRevision.current++; setDraft(event.target.value); }} />
        <button type="button" aria-label={active ? "End voice capture" : "Turn microphone on"} disabled={!active && !ready} onClick={active ? props.commands.end : props.commands.start}><img src={micIcon} alt="" /></button>
        <button className="matrix-aoede-live__send" type="submit" aria-label="Send message" disabled={sending || !props.canSendText || !draft.trim()}><img src={sendIcon} alt="" /></button>
      </form>
      <p className="matrix-aoede-live__privacy">{props.microphoneActive ? "Microphone active" : "Microphone off"}</p>
    </section>
  </div>;
}
