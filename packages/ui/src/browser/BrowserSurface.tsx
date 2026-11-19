"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { BrowserChromeAction } from "@matrix-os/contracts";
import { Globe2, Monitor, RefreshCw, X } from "lucide-react";
import { useBrowserSurface } from "./use-browser-surface.js";
import { browserHumanInputAllowed } from "./automation-state.js";
import { browserChromeModel } from "./chrome-model.js";
import { BrowserTitleBarControls } from "./BrowserTitleBarControls.js";
import type { BrowserControlAction, BrowserSurfaceProps } from "./types.js";
import "./browser.css";
import { BrowserSetupGate } from "./BrowserSetupGate.js";

export function BrowserSurface(props: BrowserSurfaceProps) {
  return props.setup ? <BrowserSetupGate key={props.gatewayUrl} setup={props.setup} active={props.active !== false} scope={props.gatewayUrl}>{recheck => <ReadyBrowserSurface {...props} recheckSetup={recheck}/>}</BrowserSetupGate> : <ReadyBrowserSurface {...props}/>;
}
// The settings toggle lives in the inline toolbar or the host title bar. Clicks
// on host chrome toggle through the action path, so they never count as outside.
function settingsTriggerIn(root: HTMLElement | null): HTMLButtonElement | null {
  return root?.querySelector<HTMLButtonElement>(".matrix-browser-titlebar button[aria-expanded]") ?? null;
}
function insideChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-matrix-browser-chrome]") !== null;
}
function ReadyBrowserSurface(props: BrowserSurfaceProps & { recheckSetup?: () => Promise<boolean> }) {
  const { state, iframe, viewerKey, reconnect: reconnectViewer, control, automationControl } = useBrowserSurface(props);
  const reconnect = async () => {
    if (props.active === false) return;
    if (!props.recheckSetup || await props.recheckSetup()) reconnectViewer();
  };
  const [settings, setSettings] = useState(false);
  const surfaceRef = useRef<HTMLElement>(null);
  const settingsTrigger = () => settingsTriggerIn(surfaceRef.current);
  const settingsPanel = useRef<HTMLElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!settings) return;
    settingsClose.current?.focus();
    const surface = surfaceRef.current;
    const dismiss = () => { setSettings(false); settingsTriggerIn(surface)?.focus(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    const onMouseDown = (event: MouseEvent) => {
      if (!settingsPanel.current?.contains(event.target as Node)
        && !insideChrome(event.target)) dismiss();
    };
    const onFocus = (event: FocusEvent) => {
      if (!settingsPanel.current?.contains(event.target as Node)
        && !insideChrome(event.target)) setSettings(false);
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
  const interactive = props.active !== false && available && connected && browserHumanInputAllowed(state.status) && !state.busy;
  const minimized = !desktop && state.status?.chrome.present && state.status.chrome.minimized;
  const automation = state.status?.automation;
  const canOpenCloudDesktop = Boolean(props.onOpenCloudDesktop);
  const chrome = useMemo(() => browserChromeModel(state, {
    surface: props.surface, active: props.active !== false, settingsOpen: settings, canOpenCloudDesktop,
  }), [canOpenCloudDesktop, props.active, props.surface, settings, state]);
  const action = async (value: BrowserControlAction) => {
    if (await control(value) && value === "restore-chrome" && desktop) props.onOpenBrowser?.();
  };
  // Title bar clicks act on the latest model only; anything it does not offer is ignored.
  const handleChromeAction = (id: BrowserChromeAction) => {
    const offered = chrome.actions.find((entry) => entry.id === id);
    if (!offered || offered.disabled) return;
    if (id === "settings") { setSettings((open) => !open); return; }
    if (id === "open-cloud-desktop") { props.onOpenCloudDesktop?.(); return; }
    if (id === "open-browser") { props.onOpenBrowser?.(); return; }
    if (id === "reconnect") { void reconnect(); return; }
    if (id === "takeover" || id === "pause" || id === "resume" || id === "stop") { void automationControl(id); return; }
    void action(id);
  };
  const runChromeAction = useEffectEvent(handleChromeAction);
  const chromeHost = props.chromeHost;
  // Hosts re-render when chrome is published, so publish only real changes;
  // otherwise a host re-render that recreates callbacks would loop.
  const chromeKey = JSON.stringify(chrome);
  const publishedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!chromeHost || publishedKey.current === chromeKey) return;
    publishedKey.current = chromeKey;
    chromeHost.publish(JSON.parse(chromeKey));
  }, [chromeHost, chromeKey]);
  useEffect(() => {
    if (!chromeHost) return;
    const detach = chromeHost.onAction((id) => runChromeAction(id));
    return () => { detach(); publishedKey.current = null; chromeHost.publish(null); };
  }, [chromeHost]);
  return <section ref={surfaceRef} className="matrix-browser-surface ph-no-capture" data-surface={props.surface} aria-label={desktop ? "Cloud desktop" : "Browser"}>
    {!chromeHost && <header className="matrix-browser-toolbar">
      <div className="matrix-browser-identity">{desktop ? <Monitor size={18} aria-hidden="true"/> : <Globe2 size={18} aria-hidden="true"/>}
        <span>{desktop ? "Cloud desktop" : "Browser"}</span></div>
      <BrowserTitleBarControls model={chrome} onAction={handleChromeAction}/>
    </header>}
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
      {connected && available && !automation && !state.status?.humanControlAvailable && <div className="matrix-browser-recovery"><strong>This view is read only</strong><button onClick={reconnect}>Take control</button></div>}
      {settings && <section ref={settingsPanel} className="matrix-browser-settings" aria-label="Browser settings">
        <div><strong>Display</strong><button ref={settingsClose} className="matrix-browser-icon-button" aria-label="Close browser settings" onClick={() => { setSettings(false); settingsTrigger()?.focus(); }}><X size={18} aria-hidden="true"/></button></div>
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
