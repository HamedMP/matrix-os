"use client";

/**
 * Shell-level host for the standalone Aoede assistant (specs/535-aoede-rewrite).
 *
 * One singleton controller lives at the shell root, above Chat and every app
 * surface — no ChatApp component owns or hides it (AO-02). The dedicated
 * launcher icon and the global command-palette action both call
 * `controller.focus()`, so racing invocations converge on the same visible
 * instance and a single bootstrap flight (AO-01). Opening never touches the
 * microphone (AO-05); dismissal stops only media through the controller —
 * canonical runs keep their own cancellation path.
 */
import {
  createAoedeController,
  AoedeCanonicalCards,
  AoedePanel,
  AoedeSettings,
  type AoedeController,
  type AoedeOwnerOptions,
} from "@matrix-os/ui/aoede";
import "@matrix-os/ui/aoede.css";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useCommandStore } from "@/stores/commands";
import { getGatewayUrl } from "@/lib/gateway";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { AudioLinesIcon } from "@/lib/hugeicons";
import {
  AOEDE_COMMAND_ID,
  aoedeIdentityKey,
  getAoedeShellFetcher,
  type AoedeShellSurface,
} from "@/lib/aoede-shell";

/** Injectable controller internals for deterministic fixtures. */
export type AoedeControllerDependencies = NonNullable<
  Parameters<typeof createAoedeController>[1]
>;

export interface ShellAoedeHostProps {
  children: ReactNode;
  /** Authenticated owner; null/undefined while signed out or in E2E bypass. */
  userId?: string | null;
  /** Explicit runtime slot (`?runtime=`); part of the immutable identity. */
  runtimeSlot?: string | null;
  /** Contract surface for the current OS view (canvas/desktop). */
  surface: AoedeShellSurface;
  /** Workspace is the default; an active project narrows the scope. */
  projectId?: string;
  /** Whether launcher/palette entries may appear on this surface. */
  supported: boolean;
  /** Canonical history/result navigation wired by the shell owner. */
  onOpenHistory?: (chatId: string) => void;
  onOpenResult?: (path: string) => void;
  /** Validated canonical app navigation (`apps/<slug>` destinations only). */
  onOpenNavigation?: (nav: { app: string; path: string }) => void;
  /** Test seam: substitute the gateway-bound fetcher. */
  fetcher?: typeof fetch;
  /** Test seam: substitute bootstrap/media factories. */
  controllerDeps?: AoedeControllerDependencies;
}

// The shared aoede-panel.css consumes the matrix token namespace; the shell
// theme publishes the tailwind namespace, so map the tokens locally instead of
// forking the shared stylesheet (same mapping the voice dock uses).
const SHELL_AOEDE_TOKEN_MAP = [
  "[--matrix-card:var(--card)]",
  "[--matrix-card-fg:var(--card-foreground)]",
  "[--matrix-fg:var(--foreground)]",
  "[--matrix-border:var(--border)]",
  "[--matrix-accent:var(--primary)]",
  "[--matrix-primary:var(--primary)]",
  "[--matrix-primary-fg:var(--primary-foreground)]",
  "[--matrix-destructive:var(--destructive)]",
  "[--matrix-muted-fg:var(--muted-foreground)]",
  "[--matrix-secondary:var(--secondary)]",
  "[--matrix-ring:var(--ring)]",
  "[--matrix-font-sans:var(--font-sans)]",
  "[--matrix-radius-sm:0.5rem]",
  "[--matrix-radius-md:0.75rem]",
  "[--matrix-radius-xl:1rem]",
].join(" ");

/** Focusable elements a light dismissal hands focus to. */
const FOCUSABLE_TARGET_SELECTOR =
  "button, a[href], input, select, textarea, [contenteditable=''], [contenteditable='true'], [role='button'], [tabindex]";

/**
 * Mount once above presentation/app switches. Identity/scope changes remount
 * the owner so stale runtime/scope work is fenced (same keying contract as
 * the shared AoedeProvider).
 */
export function ShellAoedeHost(props: ShellAoedeHostProps) {
  const identity = JSON.stringify([
    aoedeIdentityKey({
      userId: props.userId,
      runtimeSlot: props.runtimeSlot,
    }),
    getGatewayUrl(),
    props.projectId ?? null,
  ]);
  return <ShellAoedeIdentityRoot key={identity} {...props} />;
}

function ShellAoedeIdentityRoot({
  children,
  userId,
  runtimeSlot,
  surface,
  projectId,
  supported,
  onOpenHistory,
  onOpenResult,
  onOpenNavigation,
  fetcher,
  controllerDeps,
}: ShellAoedeHostProps) {
  const [controller] = useState(() =>
    createAoedeController(
      {
        identityKey: aoedeIdentityKey({ userId, runtimeSlot }),
        baseUrl: getGatewayUrl(),
        fetcher: fetcher ?? getAoedeShellFetcher(),
        surface,
        ...(projectId ? { projectId } : {}),
        ...(onOpenHistory ? { onOpenHistory } : {}),
        ...(onOpenResult ? { onOpenResult } : {}),
        ...(onOpenNavigation ? { onOpenNavigation } : {}),
      } satisfies AoedeOwnerOptions,
      controllerDeps ?? {},
    ),
  );
  const lease = useRef(0);
  useLayoutEffect(() => {
    void controller.setSurface(surface);
  }, [controller, surface]);
  useLayoutEffect(() => {
    const current = ++lease.current;
    controller.activate();
    return () => {
      controller.suspend();
      // StrictMode effect replay retains the same inert owner; real unmount
      // disposes it (mirrors the shared AoedeProvider lease). The lease must
      // be read live at microtask time — replay bumps it before disposal.
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional live read: a StrictMode replay bumps the lease between cleanup and microtask disposal
        if (lease.current === current) controller.dispose();
      });
    };
  }, [controller]);

  // A surface that becomes unsupported must stop capture and hide the panel,
  // not leave an orphaned session running invisibly.
  useEffect(() => {
    if (!supported) void controller.dismiss();
  }, [supported, controller]);

  return (
    <>
      {children}
      {supported ? <ShellAoedeEntries controller={controller} /> : null}
    </>
  );
}

/** Launcher icon + palette action + nonmodal panel for the one controller. */
function ShellAoedeEntries({ controller }: { controller: AoedeController }) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const panelId = useId();
  const focusTarget = useRef<HTMLDivElement>(null);
  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);

  useEffect(() => {
    register([
      {
        id: AOEDE_COMMAND_ID,
        label: "Aoede",
        group: "Apps",
        keywords: ["assistant", "voice", "workspace", "aoede"],
        // Focus/reveal, never toggle: a palette invocation racing an icon
        // click must converge on the same open instance, not dismiss it.
        // The invoker recorded by the palette is kept so dismissal returns
        // focus to the element that launched the command.
        execute: (context) => {
          void controller.focus(context?.invoker);
        },
      },
    ]);
    return () => unregister([AOEDE_COMMAND_ID]);
  }, [controller, register, unregister]);

  useEffect(() => {
    if (snapshot.visible) focusTarget.current?.focus();
  }, [snapshot.visible, snapshot.focusRevision]);

  // Light dismissal: an outside pointerdown stops capture/playback and hides
  // the panel while canonical work survives for reopen. Launcher presses are
  // reveal intents, not dismissal; the clicked control owns focus return.
  useEffect(() => {
    if (!snapshot.visible) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (focusTarget.current?.contains(target)) return;
      if (target.closest("[data-aoede-launcher]")) return;
      const interactive = target.closest<HTMLElement>(FOCUSABLE_TARGET_SELECTOR);
      void controller.open(interactive ?? undefined);
      void controller.dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [snapshot.visible, controller]);

  return (
    <>
      <button
        type="button"
        data-testid="aoede-launcher"
        data-aoede-launcher
        aria-label={
          snapshot.visible ? "Focus Aoede assistant" : "Open Aoede assistant"
        }
        aria-expanded={snapshot.visible}
        aria-controls={snapshot.visible ? panelId : undefined}
        className="fixed bottom-20 right-4 flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground shadow-lg transition-[transform,box-shadow,color] hover:scale-105 hover:text-foreground hover:shadow-xl active:scale-95 focus-visible:outline-2 focus-visible:outline-primary"
        style={{ zIndex: SHELL_Z_INDEX.appDialog }}
        // Reveal only: the icon never starts media. The invoker element is
        // recorded so dismissal can return focus to it (AO-05).
        onClick={(event) => void controller.focus(event.currentTarget)}
      >
        <AudioLinesIcon className="size-5" aria-hidden="true" />
      </button>
      {snapshot.visible ? (
        <div
          id={panelId}
          ref={focusTarget}
          role="dialog"
          aria-modal="false"
          aria-label="Aoede assistant"
          tabIndex={-1}
          data-testid="aoede-host"
          className={`fixed bottom-[8.5rem] right-4 max-h-[min(42rem,calc(100vh-10rem))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto outline-none ${SHELL_AOEDE_TOKEN_MAP}`}
          style={{ zIndex: SHELL_Z_INDEX.appDialog }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              void controller.dismiss();
            }
          }}
        >
          <AoedePanel
            scopeLabel={snapshot.binding?.scope.label ?? "Workspace"}
            status={snapshot.status}
            microphoneActive={snapshot.microphoneActive}
            turnMode={snapshot.turnMode}
            captions={snapshot.canonical.captions}
            capability={snapshot.binding?.capability}
            canCancel={snapshot.canonical.canCancel}
            error={snapshot.error ?? undefined}
            commands={{
              start: () => void controller.start(),
              dismiss: () => void controller.dismiss(),
              end: () => void controller.end(),
              pause: controller.pause,
              resume: controller.resume,
              stopSpeaking: controller.stopSpeaking,
              cancelGeneration: () => void controller.cancelGeneration(),
              pushToTalkStart: controller.pushToTalkStart,
              pushToTalkStop: controller.pushToTalkStop,
              retry: () => void controller.retry(),
              newConversation: () => void controller.newConversation(),
              viewHistory: controller.viewHistory,
            }}
            settings={<AoedeSettings controller={controller} snapshot={snapshot} />}
          >
            <AoedeCanonicalCards
              controller={controller}
              projection={snapshot.canonical}
            />
          </AoedePanel>
        </div>
      ) : null}
    </>
  );
}
