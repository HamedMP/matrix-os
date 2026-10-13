import { useCallback, useEffect, useMemo, useState } from "react";
import { AoedeOverlayView, useAoedeSession } from "@matrix-os/ui/aoede";
import type { AoedeClientMessage, AoedeServerMessage } from "@matrix-os/contracts";
import { MicIcon } from "../../lib/hugeicons";
import { getKernelSocket } from "../../lib/kernel-wiring";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { FIXED_DESKTOP_APPS } from "../desktop-shell/desktop-apps";
import { nativeTabOsViewPath } from "../desktop-shell/native-os-view-persistence";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import { useAppsQuery } from "../apps/apps.api";
import { createDesktopAoedeTransport } from "./transport";
import { useDesktopAoede } from "./microphone";

function VoicePanel() {
  const transport = useMemo(() => createDesktopAoedeTransport(), []);
  const kernel = getKernelSocket();
  const [connection, setConnection] = useState(() => ({ connected: kernel?.state === "connected", connectionEpoch: kernel?.connectionEpoch ?? 0 }));
  const { data: apps = [] } = useAppsQuery();
  const providerGeneration = useConnection(s => s.providerCatalogGeneration);
  useEffect(() => kernel?.onStateChange(state => setConnection({ connected: state === "connected", connectionEpoch: kernel.connectionEpoch })), [kernel]);
  useEffect(() => {
    const ui = useUi.getState(); ui.acquireRendererOverlay();
    return () => ui.releaseRendererOverlay();
  }, []);
  const subscribe = useCallback((handler: (frame: unknown) => void) => kernel?.subscribe(handler) ?? (() => {}), [kernel]);
  const send = useCallback((frame: AoedeClientMessage) => desktopProviderIdentityKey(useConnection.getState()) === transport.identityKey
    && (kernel?.sendConnected(frame) ?? false), [kernel, transport.identityKey]);
  const onUi = useCallback((frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => {
    if (desktopProviderIdentityKey(useConnection.getState()) !== transport.identityKey) return { status: "failed" as const };
    const tabs = useTabs.getState();
    const exact = apps.filter(app => app.name.toLowerCase() === frame.target.trim().toLowerCase());
    const matches = frame.phase === "execute" ? apps.filter(app => app.slug === frame.target)
      : exact.length ? exact : apps.filter(app => app.name.toLowerCase().includes(frame.target.trim().toLowerCase()));
    if (matches.length > 1) return { status: "ambiguous" as const };
    const app = matches[0];
    if (!app) return { status: "not_found" as const };
    if (frame.phase === "resolve") return { status: "ok" as const, slug: app.slug };
    const surfaces = useDesktopSurfaces.getState();
    const fixed = FIXED_DESKTOP_APPS.find(candidate => candidate.path === app.path);
    const matchesTab = (tab: typeof tabs.tabs[number]) => app.path ? nativeTabOsViewPath(tab, apps) === app.path : tab.kind === "app" && tab.slug === app.slug;
    if (frame.action === "open_app") {
      if (fixed?.settingsSection) useUi.getState().requestSettingsSection(fixed.settingsSection);
      const id = tabs.openTab(fixed ? { kind: fixed.kind, slug: fixed.slug, title: fixed.name }
        : { kind: "app", slug: app.slug, title: app.name, appIdentity: app.appIdentity });
      surfaces.reconcileTabs(useTabs.getState().tabs.map(tab => tab.id), { width: window.innerWidth,
        height: Math.max(1, window.innerHeight - NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight - NATIVE_DESKTOP_LAYOUT.tabStripHeight) });
      useDesktopSurfaces.getState().activateSurface(id);
    }
    else {
      const open = tabs.tabs.filter(tab => matchesTab(tab) && surfaces.surfaces[tab.id]?.mode !== "closed");
      if (!open.length) return { status: "not_found" as const };
      open.forEach(tab => { if (tab.closable) tabs.closeTab(tab.id); else surfaces.closeSurface(tab.id); });
    }
    const current = useTabs.getState();
    const present = current.tabs.some(tab => matchesTab(tab) && useDesktopSurfaces.getState().surfaces[tab.id]?.mode !== "closed"
      && (frame.action === "close_app" || (tab.id === current.activeTabId && useDesktopSurfaces.getState().surfaces[tab.id]?.mode !== "minimized")));
    return { status: present === (frame.action === "open_app") ? "ok" as const : "failed" as const, slug: app.slug };
  }, [apps, transport.identityKey]);
  const session = useAoedeSession(true, onUi, { ...transport, socket: { ...connection, subscribe, send } });
  useEffect(() => { if (providerGeneration > 0) void session.refreshReadiness(); }, [providerGeneration, session.refreshReadiness]);
  const openSettings = () => {
    useUi.getState().requestSettingsSection("agents-providers");
    const id = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
    useDesktopSurfaces.getState().activateSurface(id);
  };
  return <AoedeOverlayView active session={session} permissionSurface="desktop"
    onDismiss={() => useDesktopAoede.getState().setOpen(false)} onOpenSettings={openSettings} />;
}

export default function DesktopAoede() {
  const open = useDesktopAoede(s => s.open);
  const identityKey = useConnection(desktopProviderIdentityKey);
  useEffect(() => () => useDesktopAoede.getState().setOpen(false), [identityKey]);
  return <>
    <button type="button" className="no-drag flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      style={{ color: "var(--text-secondary)" }} aria-label="Open Aoede" title="Aoede voice assistant"
      onClick={() => useDesktopAoede.getState().setOpen(true)}><MicIcon size={16} aria-hidden /></button>
    {open && <VoicePanel key={identityKey} />}
  </>;
}
