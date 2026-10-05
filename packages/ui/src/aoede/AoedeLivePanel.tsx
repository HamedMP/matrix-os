"use client";
import "./aoede-live.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { desktopPalette, fonts } from "@matrix-os/brand/tokens";
import type { AoedePanelProps } from "./AoedePanel.js";
import { aoedeErrorCopy, AOEDE_STATUS_LABELS } from "./presentation.js";

/** Shared live presentation. Pointer-transparent halo, readable caption
 * scrim, and an optional context drawer leave the OS usable while talking.
 */
export function AoedeLivePanel(props: AoedePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const conversation = useRef<HTMLElement>(null);
  useEffect(() => { conversation.current?.focus(); }, [props.focusRevision]);
  const active = !["idle", "ended", "failed"].includes(props.status);
  const style = { "--live-forest": desktopPalette.forest, "--live-paper": desktopPalette.paper,
    "--live-gold": desktopPalette.gold, "--live-coral": desktopPalette.coral, "--live-blue": desktopPalette.blue,
    "--live-serif": fonts.display } as CSSProperties;
  return <div data-aoede-live className="matrix-aoede-live" data-state={props.status} style={style}>
    {active ? <div className="matrix-aoede-live__halo" aria-hidden="true" /> : null}
    <section ref={conversation} tabIndex={-1} role="dialog" aria-modal="false" className="matrix-aoede-live__conversation" aria-label="Aoede live conversation" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); props.commands.dismiss(); }
    }}>
      <div className="matrix-aoede-live__meta"><span>Aoede · {AOEDE_STATUS_LABELS[props.status]}</span><span>{props.scopeLabel}</span></div>
      <div className="matrix-aoede-live__captions" aria-live="polite" aria-atomic="false">
        {props.captions.utterance ? <p><span>You</span>{props.captions.utterance}</p> : null}
        {props.captions.response ? <p><span>Aoede{props.captions.interrupted ? " · interrupted" : ""}</span>{props.captions.response}</p> : null}
        {!props.captions.utterance && !props.captions.response ? <p>I'm here. Take your time.</p> : null}
      </div>
      {props.error ? <p role="alert">{aoedeErrorCopy(props.error.code)}</p> : null}
      <div role="group" aria-label="Aoede controls" className="matrix-aoede-live__controls">
        {!active ? <button type="button" disabled={props.capability?.status !== "available"} onClick={props.commands.start}>Start talking</button> : null}
        {active ? <button type="button" onClick={props.status === "paused" ? props.commands.resume : props.commands.pause}>{props.status === "paused" ? "Unmute" : "Mute"}</button> : null}
        {props.status === "speaking" ? <button type="button" onClick={props.commands.stopSpeaking}>Stop speaking</button> : null}
        <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>Context & tasks</button>
        <button type="button" onClick={props.commands.viewHistory}>Chat history</button>
        <button type="button" onClick={props.commands.newConversation} disabled={props.status === "ending"}>New conversation</button>
        <button type="button" onClick={() => { setSettings(v => !v); setExpanded(true); }}>Settings</button>
        {props.status === "failed" && props.error?.retryable ? <button type="button" onClick={props.commands.retry}>Retry</button> : null}
        {active ? <button type="button" onClick={props.commands.end}>End voice</button> : null}
        <button type="button" onClick={props.commands.dismiss}>Dismiss</button>
      </div>
      <div className="matrix-aoede-live__context" hidden={!expanded}>
        {settings ? props.settings : null}
        <div hidden={settings}>{props.children}</div>
        <p>Memory coming soon. Previous chats remain available through source-linked retrieval.</p>
        <p>Voice ends capture and playback. Authorized tasks continue in Chat.</p>
      </div>
      <p className="matrix-aoede-live__privacy">{props.microphoneActive ? "Microphone active" : "Microphone off"} · Gemini Live · Aoede</p>
    </section>
  </div>;
}
