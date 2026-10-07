"use client";
import "./aoede-live.css";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { chatWidget, desktopPalette } from "@matrix-os/brand/tokens";
import { SHELL_Z_INDEX, DESKTOP_Z_INDEX } from "../shell-layering.js";
import type { AoedePanelProps } from "./AoedePanel.js";
import { aoedeErrorCopy, aoedeReadinessCopy, AOEDE_STATUS_LABELS, boundedAoedeText } from "./presentation.js";
import { MatrixChatAvatar } from "../chat/ChatPresentation.js";
import { ChatIcon } from "../chat/ChatIcon.js";
import { useCaptionFollow } from "./use-caption-follow.js";
import { AoedePendingText } from "./AoedePendingText.js";
import { useAoedeTextComposer } from "./use-text-composer.js";
/** Compact canonical chat follows the approved onboarding widget. Voice adds a
 * pointer-transparent edge halo; readiness never changes the presentation.
 */
export function AoedeLivePanel(props: AoedePanelProps & { pushToTalkControl?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [more, setMore] = useState(false);
  const composer = useAoedeTextComposer(props);
  const { sending, textError } = composer;
  const conversation = useRef<HTMLElement>(null);
  useEffect(() => { conversation.current?.focus(); }, [props.focusRevision]);
  const { active, ready, style } = livePresentation(props);
  return <div data-aoede-live className="matrix-aoede-live ph-no-capture" data-state={props.status} style={style}>
    {active ? <div className="matrix-aoede-live__halo" aria-hidden="true" /> : null}
    <section ref={conversation} tabIndex={-1} role="dialog" aria-modal="false" className="matrix-aoede-live__conversation" aria-label="Aoede live conversation" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); props.commands.dismiss(); }
    }}>
      <header className="matrix-aoede-live__header">
        <MatrixChatAvatar className="matrix-aoede-live__avatar" />
        <strong>Matrix</strong>
        <button type="button" aria-label="More options" aria-expanded={more} onClick={() => setMore(v => !v)}><ChatIcon name="more" size={14} /></button>
        <button type="button" aria-label="Dismiss Aoede" onClick={props.commands.dismiss}><ChatIcon name="minimize" size={14} /></button>
        <button type="button" aria-label="Expand conversation" disabled={!props.commands.viewHistory || props.canOpenConversation === false} onClick={props.commands.viewHistory}><ChatIcon name="expand" size={14} /></button>
      </header>
      <div className="matrix-aoede-live__body">
        <div className="matrix-aoede-live__meta"><span role="status">{props.capability || active ? AOEDE_STATUS_LABELS[props.status] : props.status === "failed" ? "Connection unavailable" : "Connecting"}</span><span>{boundedAoedeText(props.scopeLabel, 160)}</span></div>
        <AoedeLiveCaptions props={props} />
        <AoedePendingText pending={props.pendingText} retry={props.commands.retryPendingText ? composer.retryPending : undefined} />
        {props.error ? <p className="matrix-aoede-live__error" role="alert">{aoedeErrorCopy(props.error.code)}</p> : null}
        {!active ? <p className="matrix-aoede-live__readiness">{aoedeReadinessCopy(props.capability, props.status)}</p> : null}
        <AoedeLiveControls props={props} active={active} ready={ready} />
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
      <AoedeLiveComposer props={props} composer={composer} active={active} ready={ready} />
      <p className="matrix-aoede-live__privacy">{props.microphoneActive ? "Microphone active" : "Microphone off"}</p>
    </section>
  </div>;
}

function AoedeLiveControls({ props, active, ready }: { props: AoedePanelProps & { pushToTalkControl?: ReactNode }; active: boolean; ready: boolean }) {
  return <div role="group" aria-label="Aoede controls" className="matrix-aoede-live__controls">
          {props.pushToTalkControl}
          {!active ? <button type="button" disabled={!ready} onClick={props.commands.start}>Start talking</button> : null}
          {active ? <button type="button" onClick={props.status === "paused" ? props.commands.resume : props.commands.pause}>{props.status === "paused" ? "Unmute" : "Mute"}</button> : null}
          {props.status === "speaking" ? <button type="button" onClick={props.commands.stopSpeaking}>Stop speaking</button> : null}
          {props.status === "failed" && props.error?.retryable ? <button type="button" onClick={props.commands.retry}>Retry</button> : null}
          {active ? <button type="button" onClick={props.commands.end}>End voice</button> : null}
        </div>;
}

function AoedeLiveCaptions({ props }: { props: AoedePanelProps }) {
  const { captions, onCaptionScroll } = useCaptionFollow(props.conversationKey, props.captions);
  return <div ref={captions} className="matrix-aoede-live__captions" onScroll={onCaptionScroll} aria-live="polite" aria-atomic="false">
          {props.captions.utterance ? <p><span>You</span>{boundedAoedeText(props.captions.utterance)}</p> : null}
          {props.captions.response ? <div role="region" aria-label="Current response" className="matrix-aoede-live__response"><span>Matrix{props.captions.interrupted ? " · interrupted" : ""}</span>{props.renderResponse?.(boundedAoedeText(props.captions.response)) ?? boundedAoedeText(props.captions.response)}</div> : null}
          {!props.captions.utterance && !props.captions.response && props.status !== "failed" ? <p>{props.capability ? "What would you like to do?" : "Connecting to your workspace…"}</p> : null}
        </div>;
}

function AoedeLiveComposer({ props, composer, active, ready }: { props: AoedePanelProps; composer: ReturnType<typeof useAoedeTextComposer>; active: boolean; ready: boolean }) {
  const { draft, changeDraft, sending, submit } = composer;
  return <form className="matrix-aoede-live__composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <input aria-label="Message Matrix" placeholder="Or type what you need…" value={draft} maxLength={8000} disabled={!props.canSendText}
          onChange={event => changeDraft(event.target.value)} />
        <button type="button" aria-label={active ? "End voice capture" : "Turn microphone on"} disabled={!active && !ready} onClick={active ? props.commands.end : props.commands.start}><ChatIcon name="microphone" /></button>
        <button className="matrix-aoede-live__send" type="submit" aria-label="Send message" disabled={sending || Boolean(props.pendingText) || !props.canSendText || !draft.trim()}><ChatIcon name="send" /></button>
      </form>;
}

function livePresentation(props: AoedePanelProps) {
  const active = Boolean(props.capability) && !["idle", "ended", "failed"].includes(props.status);
  const ready = props.capability?.status === "available" && props.capability.turnModes.includes(props.turnMode);
  const style = { zIndex: (props.surface ?? props.capability?.surface) === "electron_desktop" ? DESKTOP_Z_INDEX.voiceCompanion : SHELL_Z_INDEX.voiceCompanion,
    "--live-forest": desktopPalette.forest, "--live-paper": desktopPalette.paper,
    "--live-gold": desktopPalette.gold, "--live-coral": desktopPalette.coral, "--live-blue": desktopPalette.blue,
    "--live-sans": chatWidget.fontFamily,
    "--live-widget": chatWidget.colors.surface, "--live-border": chatWidget.colors.border,
    "--live-ink": chatWidget.colors.ink, "--live-muted": chatWidget.colors.muted,
    "--live-text": chatWidget.colors.text, "--live-placeholder": chatWidget.colors.placeholder,
    "--live-composer": chatWidget.colors.composer,
  } as CSSProperties;
  return { active, ready, style };
}
