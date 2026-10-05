"use client";
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createAoedeController, type AoedeController, type AoedeProviderProps } from "./controller.js";
import { AoedePanel } from "./AoedePanel.js";
import { AoedeSettings } from "./AoedeSettings.js";
import { AoedeCanonicalCards } from "./AoedeCanonicalCards.js";

const Context = createContext<AoedeController | null>(null);
/** Launcher adapters may be mounted without an authenticated voice owner. */
export function useOptionalAoedeController() { return useContext(Context); }
/** Mount once above presentation/app switches. Identity/scope changes remount the owner. */
export function AoedeProvider(props: AoedeProviderProps) {
  const identity = JSON.stringify([props.identityKey, props.baseUrl, props.projectId ?? null]);
  return <IdentityOwner key={identity} {...props} />;
}
function IdentityOwner({ children, ...options }: AoedeProviderProps) {
  const [controller] = useState(() => createAoedeController(options));
  const lease = useRef(0);
  useLayoutEffect(() => {
    void controller.setSurface(options.surface);
  }, [controller, options.surface]);
  useLayoutEffect(() => {
    const current = ++lease.current;
    controller.activate();
    return () => {
      controller.suspend();
      // StrictMode effect replay retains the same inert owner; real unmount disposes it.
      queueMicrotask(() => { if (lease.current === current) controller.dispose(); });
    };
  }, [controller]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useAoede() {
  const controller = useContext(Context);
  if (!controller) throw new Error("AoedeProvider is required");
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return {
    controller, snapshot,
    open(invoker?: HTMLElement): void { void controller.open(invoker); },
    focus(invoker?: HTMLElement): void { void controller.focus(invoker); },
    toggle(invoker?: HTMLElement): void { void controller.toggle(invoker); },
    dismiss: controller.dismiss,
  };
}
/** No positioning or modal ownership: the renderer supplies a nonmodal shell host. */
export function AoedeAssistant() {
  const { controller, snapshot } = useAoede();
  const focusTarget = useRef<HTMLDivElement>(null);
  useEffect(() => { if (snapshot.visible && controller.presentation === "classic") focusTarget.current?.focus(); }, [controller, snapshot.visible, snapshot.focusRevision]);
  if (!snapshot.visible) return null;
  return <div ref={focusTarget} role="dialog" aria-modal="false" aria-label="Aoede assistant" tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); void controller.dismiss(); }
  }}>
    <AoedePanel presentation={controller.presentation} conversationKey={snapshot.binding?.chatId} surface={controller.surface()} canSendText={controller.canSendText()} scopeLabel={snapshot.binding?.scope.label ?? "Workspace"} status={snapshot.status} focusRevision={snapshot.focusRevision}
      microphoneActive={snapshot.microphoneActive} turnMode={snapshot.turnMode} captions={snapshot.canonical.captions}
      capability={snapshot.binding?.capability} error={snapshot.error ?? undefined}
      canCancel={snapshot.canonical.canCancel}
      commands={{ sendText: controller.sendText, start: () => void controller.start(), dismiss: () => void controller.dismiss(), end: () => void controller.end(),
        pause: controller.pause, resume: controller.resume, stopSpeaking: controller.stopSpeaking,
        cancelGeneration: () => void controller.cancelGeneration(),
        pushToTalkStart: controller.pushToTalkStart, pushToTalkStop: controller.pushToTalkStop,
        retry: () => void controller.retry(), newConversation: () => void controller.newConversation(), viewHistory: controller.viewHistory }}
      settings={<AoedeSettings controller={controller} snapshot={snapshot} />}>
      <AoedeCanonicalCards controller={controller} projection={snapshot.canonical} />
    </AoedePanel>
  </div>;
}
export type { AoedeProviderProps } from "./controller.js";
