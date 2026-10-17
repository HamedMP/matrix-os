"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Globe2, Monitor, RefreshCw, Settings2, Terminal, X, Pause, Play, Hand, Square } from "lucide-react";
import { useBrowserSurface } from "./use-browser-surface.js";
import { browserAutomationActionAllowed, browserControlLabel, browserHumanInputAllowed } from "./automation-state.js";
import type { BrowserControlAction, BrowserSurfaceProps } from "./types.js";
import "./browser.css";

export function BrowserSurface(props: BrowserSurfaceProps) {
  const { state, iframe, viewerKey, reconnect, control, automationControl } = useBrowserSurface(props);
  const [settings, setSettings] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!settings) return;
    settingsClose.current?.focus();
    const dismiss = () => { setSettings(false); settingsTrigger.current?.focus(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    const onMouseDown = (event: MouseEvent) => {
      if (!settingsPanel.current?.contains(event.target as Node)
        && !settingsTrigger.current?.contains(event.target as Node)) dismiss();
    };
    const onFocus = (event: FocusEvent) => {
      if (!settingsPanel.current?.contains(event.target as Node)
        && !settingsTrigger.current?.contains(event.target as Node)) setSettings(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("focusin", onFocus);
    };
  }, [settings]);
  const desktop = props.surface === "desktop";
  const available = state.status?.available === true;
  const connected = state.connection === "connected";
  const interactive = available && connected && browserHumanInputAllowed(state.status) && !state.busy;
  const automation = state.status?.automation;
  const automationReady = available && connected && !state.busy && props.active !== false;
  const minimized = !desktop && state.status?.chrome.present && state.status.chrome.minimized;
  const label = state.connection === "connected" ? "Connected" : state.connection === "disconnected" ? "Disconnected"
    : state.connection === "unavailable" ? "Unavailable" : state.connection === "inactive" ? "Paused" : "Connecting…";
  const action = async (value: BrowserControlAction) => {
    if (await control(value) && value === "restore-chrome" && desktop) props.onOpenBrowser?.();
  };
  return <section className="matrix-browser-surface ph-no-capture" data-surface={props.surface} aria-label={desktop ? "Cloud desktop" : "Browser"}>
    <header className="matrix-browser-toolbar">
      <div className="matrix-browser-identity">{desktop ? <Monitor size={20} aria-hidden="true"/> : <Globe2 size={20} aria-hidden="true"/>}
        <span>{desktop ? "Cloud desktop" : "Browser"}</span></div>
      <span className="matrix-browser-state" role="status" data-connected={connected}>{state.busy ? "Applying action…" : label}</span>
      {connected && <span className="matrix-browser-control-state" role="status">{browserControlLabel(state)}</span>}
      <div className="matrix-browser-actions">
        {automation && !automation.run && browserAutomationActionAllowed(state.status, "takeover") && <button disabled={!automationReady} onClick={() => { void automationControl("takeover"); }}><Hand size={16} aria-hidden="true"/>Take control</button>}
        {automation?.run && <>
          {["agent", "pausing"].includes(automation.phase) && <button disabled={!automationReady || !browserAutomationActionAllowed(state.status, "pause")} onClick={() => { void automationControl("pause"); }}><Pause size={16} aria-hidden="true"/>Pause agent</button>}
          {["agent", "paused", "pausing"].includes(automation.phase) && <button disabled={!automationReady || !browserAutomationActionAllowed(state.status, "takeover")} onClick={() => { void automationControl("takeover"); }}><Hand size={16} aria-hidden="true"/>Take over</button>}
          {["paused", "human", "resuming"].includes(automation.phase) && <button disabled={!automationReady || !browserAutomationActionAllowed(state.status, "resume")} onClick={() => { void automationControl("resume"); }}><Play size={16} aria-hidden="true"/>Resume agent</button>}
          <button disabled={!automationReady || !browserAutomationActionAllowed(state.status, "stop")} onClick={() => { void automationControl("stop"); }}><Square size={16} aria-hidden="true"/>Stop agent</button>
        </>}
        {desktop ? <>
          <button disabled={!interactive} onClick={() => { void action("show-desktop"); }}><Monitor size={16} aria-hidden="true"/>Show desktop</button>
          <button disabled={!interactive} onClick={() => { void action("open-files"); }}><FolderOpen size={16} aria-hidden="true"/>Files</button>
          <button disabled={!interactive} onClick={() => { void action("open-terminal"); }}><Terminal size={16} aria-hidden="true"/>Terminal</button>
          <button disabled={!interactive} onClick={() => { void action("restore-chrome"); }}><Globe2 size={16} aria-hidden="true"/>Open Chrome</button>
        </> : <>
          {props.onOpenCloudDesktop && <button onClick={props.onOpenCloudDesktop}><Monitor size={16} aria-hidden="true"/>Cloud desktop</button>}
        </>}
        {!settings && (state.connection === "disconnected" || state.connection === "unavailable") && <button disabled={state.busy || props.active === false} onClick={reconnect}><RefreshCw size={16} aria-hidden="true"/>Reconnect</button>}
        <button ref={settingsTrigger} className="matrix-browser-icon-button" aria-label="Browser settings" aria-expanded={settings} onClick={() => setSettings(value => !value)}><Settings2 size={18} aria-hidden="true"/></button>
      </div>
    </header>
    {state.error && <p className="matrix-browser-error" role="alert">{state.error}</p>}
    <div className="matrix-browser-viewport">
      {state.viewerUrl && <iframe key={viewerKey} ref={iframe} title={desktop ? "Your Matrix cloud desktop" : "Chrome on your Matrix computer"}
        src={state.viewerUrl} allow="clipboard-read; clipboard-write; fullscreen" tabIndex={interactive ? 0 : -1}
        inert={!interactive} style={{ pointerEvents: interactive ? "auto" : "none" }}/>}
      {!state.viewerUrl && <div className="matrix-browser-placeholder">
        {desktop ? <Monitor size={28} aria-hidden="true"/> : <Globe2 size={28} aria-hidden="true"/>}
        <strong>{state.connection === "unavailable" ? `${desktop ? "Cloud desktop" : "Browser"} unavailable`
          : state.connection === "disconnected" ? "Connection ended" : state.connection === "inactive" ? "Ready when you return" : `Opening ${desktop ? "your cloud desktop" : "Chrome"}…`}</strong>
        <p>{state.connection === "disconnected" ? "Reconnect to continue. Your tabs and apps stay open."
          : state.connection === "unavailable" ? "Check your Matrix computer, then reconnect."
          : "Your browser and apps run on your Matrix computer."}</p>
      </div>}
      {minimized && state.viewerUrl && <div className="matrix-browser-recovery"><strong>Chrome is minimized</strong>
        <button disabled={!interactive} onClick={() => { void action("restore-chrome"); }}>Restore Chrome</button></div>}
      {connected && !automation && !state.status?.humanControlAvailable && <div className="matrix-browser-recovery"><strong>This view is read only</strong><button onClick={reconnect}>Take control</button></div>}
      {settings && <section ref={settingsPanel} className="matrix-browser-settings" aria-label="Browser settings">
        <div><strong>Display</strong><button ref={settingsClose} className="matrix-browser-icon-button" aria-label="Close browser settings" onClick={() => { setSettings(false); settingsTrigger.current?.focus(); }}><X size={18} aria-hidden="true"/></button></div>
        <p>The desktop fits this window so Chrome’s tabs, extensions and dialogs remain within reach.</p>
        <p>Closing this view leaves Chrome and your apps open on your Matrix computer.</p>
        <div className="matrix-browser-settings-actions">
          {!desktop && <button disabled={!interactive} onClick={() => { void action("restore-chrome"); }}><Globe2 size={16} aria-hidden="true"/>Restore Chrome</button>}
          <button disabled={state.busy || props.active === false} onClick={() => { setSettings(false); reconnect(); }}><RefreshCw size={16} aria-hidden="true"/>Reconnect</button>
        </div>
      </section>}
    </div>
  </section>;
}
