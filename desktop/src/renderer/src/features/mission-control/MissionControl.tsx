import { useEffect } from "react";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useWorkspace, type PanelLayout } from "../../stores/workspace";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import NavigationHeader from "./NavigationHeader";
import Composer from "../threads/Composer";
import CommandPalette from "../palette/CommandPalette";
import CreateProjectDialog from "../board/CreateProjectDialog";
import QuickOpen from "../files/QuickOpen";
import { useGlobalShortcuts } from "./shortcuts";
import { invoke } from "../../lib/operator";
import { wireKernel } from "../../lib/kernel-wiring";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { useShellSessionSync } from "../../lib/shell-session-sync";
import { preloadAppIcons, useApps } from "../../stores/apps";
import NativeDesktopShell from "../desktop-shell/NativeDesktopShell";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";

export default function MissionControl() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const authGeneration = useConnection((s) => s.authGeneration);
  const loadProjects = useBoard((s) => s.loadProjects);
  const loadApps = useApps((s) => s.load);
  const loadNativeDesktopMode = useNativeDesktopMode((s) => s.load);
  const createProjectOpen = useUi((s) => s.createProjectOpen);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const rendererOverlayOpen = useUi(
    (s) =>
      s.paletteOpen ||
      s.composerOpen ||
      s.quickOpenOpen ||
      s.appLauncherOpen ||
      s.createProjectOpen ||
      s.rendererOverlayCount > 0,
  );

  useGlobalShortcuts();
  useShellSessionSync(api, `${runtimeScope}|${authGeneration}|${runtimeSlot}`);

  useEffect(() => {
    void loadNativeDesktopMode();
  }, [loadNativeDesktopMode]);

  useEffect(() => {
    const { configure, hydrate } = useWorkspace.getState();
    configure({
      loadLayouts: async () => {
        const result = await invoke("state:get", { key: "panelLayouts" });
        return (result.value as Record<string, PanelLayout> | null) ?? null;
      },
      saveLayout: async (taskKey, layout) => {
        await invoke("state:set-panel-layout", { taskKey, layout });
      },
    });
    void hydrate();
  }, []);

  useEffect(() => {
    useTabs.getState().ensureNavigationScope(`${runtimeScope}|${authGeneration}`);
  }, [authGeneration, runtimeScope]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      await loadProjects(api);
      if (cancelled) return;
      // Boot to the last-used project (FR-013/SC-001); fall back to the first.
      const { projects, activeProjectSlug, selectProject } = useBoard.getState();
      if (activeProjectSlug || projects.length === 0) return;
      let saved: unknown = null;
      try {
        saved = (await invoke("state:get", { key: "lastProjectSlug" })).value;
      } catch (err: unknown) {
        console.warn(
          "[mission-control] load last project failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      const target = projects.find((p) => p.slug === saved) ?? projects[0];
      if (target && !cancelled) {
        try {
          await selectProject(api, target.slug);
        } catch (err: unknown) {
          if (!cancelled) {
            console.warn(
              "[mission-control] restore last project failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    })().catch((err: unknown) => {
      console.warn(
        "[mission-control] initial project load failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadProjects, runtimeSlot]);

  // Warm the catalog and icon cache as soon as this computer is connected,
  // rather than making the first Apps-tab visit wait for both request stages.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void loadApps(api).then(() => {
      if (!cancelled) {
        preloadAppIcons(platformHost, runtimeSlot, useApps.getState().apps);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadApps, platformHost, runtimeSlot]);

  useEffect(() => {
    if (!api) return;
    const dispose = wireKernel();
    return dispose;
  }, [api, platformHost, runtimeSlot]);

  // Eagerly load the coding-agent runtime summary: the Agents page used to own
  // this fetch; project headers and the command palette now read it.
  // Runtime switches clear the store centrally
  // (reconcileDesktopRuntimeChange), so this just (re)loads for the scope.
  useEffect(() => {
    if (!api || !CODING_AGENTS_DESKTOP_WORKSPACE) return;
    const workspace = useCodingAgentWorkspace.getState();
    workspace.ensureRuntimeScope(runtimeScope);
    void workspace.refresh().then(() => {
      const current = useCodingAgentWorkspace.getState();
      if (current.notificationPreferencesStatus === "idle") {
        void current.loadNotificationPreferences();
      }
    });
  }, [api, runtimeScope, runtimeSlot]);

  return (
    <div
      className="relative flex flex-1 overflow-hidden"
      style={{
        background: "var(--bg-app)",
      }}
    >
      <NavigationHeader />
      <NativeDesktopShell overlayOpen={rendererOverlayOpen} />
      <Composer />
      <CommandPalette />
      <QuickOpen />
      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
    </div>
  );
}
