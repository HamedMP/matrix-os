"use client";

import { useEffect, useRef, useCallback } from "react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useCanvasGroups, type CanvasGroup } from "@/stores/canvas-groups";
import { useCanvasLabels, type CanvasLabel } from "@/stores/canvas-labels";
import { useCanvasSettings, type CanvasNavMode } from "@/stores/canvas-settings";
import { CanvasTransform } from "./CanvasTransform";
import { CanvasWindow } from "./CanvasWindow";
import { CanvasGroupRect } from "./CanvasGroup";
import { CanvasTextLabel } from "./CanvasTextLabel";
import { SelectionRect } from "./SelectionRect";
import { autoArrangeWindows } from "./CanvasToolbar";
import { CanvasMinimap } from "./CanvasMinimap";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface CanvasData {
  transform?: { zoom: number; panX: number; panY: number };
  groups?: CanvasGroup[];
  labels?: CanvasLabel[];
  settings?: { navMode?: CanvasNavMode; showTitles?: boolean };
}

const GROUP_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

export function CanvasRenderer() {
  const windows = useWindowManager((s) => s.windows);
  const setTransform = useCanvasTransform((s) => s.setTransform);
  const fitAll = useCanvasTransform((s) => s.fitAll);
  const groups = useCanvasGroups((s) => s.groups);
  const setGroups = useCanvasGroups((s) => s.setGroups);
  const createGroup = useCanvasGroups((s) => s.createGroup);
  const addToGroup = useCanvasGroups((s) => s.addToGroup);
  const labels = useCanvasLabels((s) => s.labels);
  const setLabels = useCanvasLabels((s) => s.setLabels);
  const setNavMode = useCanvasSettings((s) => s.setNavMode);
  const setShowTitles = useCanvasSettings((s) => s.setShowTitles);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    fetch(`${GATEWAY_URL}/api/canvas`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: CanvasData | null) => {
        if (data?.groups && data.groups.length > 0) {
          setGroups(data.groups);
        }
        if (data?.labels && data.labels.length > 0) {
          setLabels(data.labels);
        }
        if (data?.settings) {
          if (data.settings.navMode) setNavMode(data.settings.navMode);
          if (data.settings.showTitles !== undefined) setShowTitles(data.settings.showTitles);
        }
        // Always fitAll on mount to ensure windows are visible.
        // Previously we restored saved transform, but that causes users
        // to get stuck in a zoomed-in state after mode switching.
        const currentWindows = useWindowManager.getState().windows;
        if (currentWindows.length > 0) {
          fitAll(
            currentWindows.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
            window.innerWidth,
            window.innerHeight,
          );
        } else {
          setTransform(1, 0, 0);
        }
      })
      .catch(() => {});
  }, [setTransform, fitAll, setGroups, setLabels, setNavMode, setShowTitles, windows]);

  const autoArrange = useCallback(
    (wins: typeof windows) => {
      if (wins.length === 0) return;
      const cols = 3;
      const gap = 20;
      const wm = useWindowManager.getState();
      for (let i = 0; i < wins.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = gap + col * (640 + gap);
        const y = gap + row * (480 + gap);
        wm.moveWindow(wins[i].id, x, y);
      }
      const arranged = useWindowManager.getState().windows;
      fitAll(
        arranged.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
        window.innerWidth,
        window.innerHeight,
      );
    },
    [fitAll],
  );

  // Debounced save of canvas state (transform + groups)
  useEffect(() => {
    const unsubTransform = useCanvasTransform.subscribe(
      (state) => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      (transform) => scheduleSave(transform),
    );
    const unsubGroups = useCanvasGroups.subscribe(
      (state) => state.groups,
      () => scheduleSave(),
    );
    const unsubLabels = useCanvasLabels.subscribe(
      (state) => state.labels,
      () => scheduleSave(),
    );
    const unsubSettings = useCanvasSettings.subscribe(
      (state) => ({ navMode: state.navMode, showTitles: state.showTitles }),
      () => scheduleSave(),
    );

    function scheduleSave(transformOverride?: { zoom: number; panX: number; panY: number }) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const transform = transformOverride ?? {
          zoom: useCanvasTransform.getState().zoom,
          panX: useCanvasTransform.getState().panX,
          panY: useCanvasTransform.getState().panY,
        };
        const currentGroups = useCanvasGroups.getState().groups;
        const currentLabels = useCanvasLabels.getState().labels;
        const { navMode, showTitles } = useCanvasSettings.getState();
        fetch(`${GATEWAY_URL}/api/canvas`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transform,
            groups: currentGroups,
            labels: currentLabels,
            settings: { navMode, showTitles },
          }),
        }).catch(() => {});
      }, 500);
    }

    return () => {
      unsubTransform();
      unsubGroups();
      unsubLabels();
      unsubSettings();
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  const onSelect = useCallback(
    (windowIds: string[]) => {
      if (windowIds.length < 2) return;
      const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
      const label = `Group ${groups.length + 1}`;
      const groupId = createGroup(label, color);
      for (const winId of windowIds) {
        addToGroup(groupId, winId);
      }
    },
    [groups.length, createGroup, addToGroup],
  );

  const createLabel = useCanvasLabels((s) => s.createLabel);
  const screenToCanvas = useCanvasTransform((s) => s.screenToCanvas);

  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget) return;
      const canvas = screenToCanvas(e.clientX, e.clientY);
      createLabel("Label", canvas.x, canvas.y);
    },
    [screenToCanvas, createLabel],
  );

  // Minimized windows stay mounted (display:none in CanvasWindow) so their
  // iframe / terminal state survives a minimize -> restore round-trip. We
  // still derive a visible-windows list for empty-state and fit-all logic.
  const visibleWindows = windows.filter((w) => !w.minimized);

  const handleFitAll = useCallback(() => {
    const wins = useWindowManager.getState().windows.filter((w) => !w.minimized);
    fitAll(
      wins.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      window.innerWidth,
      window.innerHeight,
    );
  }, [fitAll]);

  // Keyboard shortcuts for canvas mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key;

      if (key === "k" && e.shiftKey) {
        e.preventDefault();
        autoArrangeWindows();
      } else if (key === "0") {
        e.preventDefault();
        handleFitAll();
      } else if (key === "1") {
        e.preventDefault();
        useCanvasTransform.getState().resetZoom();
      } else if (key === "=" || key === "+") {
        e.preventDefault();
        useCanvasTransform.getState().zoomIn();
      } else if (key === "-") {
        e.preventDefault();
        useCanvasTransform.getState().zoomOut();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleFitAll]);

  return (
    <div className="relative w-full h-full">
      <CanvasTransform className="w-full h-full" onDoubleClick={onCanvasDoubleClick}>
        <SelectionRect onSelect={onSelect} />
        {labels.map((label) => (
          <CanvasTextLabel key={label.id} label={label} />
        ))}
        {groups.map((group) => (
          <CanvasGroupRect key={group.id} group={group} />
        ))}
        {visibleWindows.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-white/50 drop-shadow-md">
              No apps running. Try &quot;Build me a notes app&quot; in the chat.
            </p>
          </div>
        )}
        {windows.map((win) => (
          <CanvasWindow key={win.id} win={win} hidden={win.minimized} />
        ))}
      </CanvasTransform>
      <CanvasMinimap />
    </div>
  );
}
