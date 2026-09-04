"use client";

import { useEffect } from "react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { patchWebOsViewState } from "@/lib/os-view-state-client";
import { useDesktopMode } from "@/stores/desktop-mode";

const TRANSFORM_SAVE_DEBOUNCE_MS = 500;
const TRANSFORM_SAVE_RETRY_MS = 2_000;

export function useCanvasTransformPersistence(gatewayUrl: string): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const persistLatestTransform = () => {
      if (disposed || useDesktopMode.getState().mode !== "canvas") return;
      const { zoom, panX, panY } = useCanvasTransform.getState();
      void patchWebOsViewState(gatewayUrl, {
        canvas: { transform: { zoom, panX, panY } },
      }).catch((error: unknown) => {
        if (disposed) return;
        console.warn("[os-view-state] Canvas transform persist failed:", error instanceof Error ? error.name : "UnknownError");
        clearTimeout(timer);
        timer = setTimeout(persistLatestTransform, TRANSFORM_SAVE_RETRY_MS);
      });
    };
    const unsubscribe = useCanvasTransform.subscribe(
      (state) => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      () => {
        if (useDesktopMode.getState().mode !== "canvas") return;
        clearTimeout(timer);
        timer = setTimeout(persistLatestTransform, TRANSFORM_SAVE_DEBOUNCE_MS);
      },
      { equalityFn: (left, right) => left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY },
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [gatewayUrl]);
}
