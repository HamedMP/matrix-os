export type WorkLayout = "wide" | "medium" | "narrow";
export type NarrowWorkPane = "rail" | "chat" | "inspector";

export interface WorkResponsiveState {
  layout: WorkLayout;
  navigationOpen: boolean;
  inspectorOpen: boolean;
  narrowPane: NarrowWorkPane;
  narrowPaneRouteKey: string | null;
}

export const WIDE_WORK_MIN_WIDTH = 1_280;
export const MEDIUM_WORK_MIN_WIDTH = 740;
export const NAVIGATION_WIDTH = 240;
export const MIN_INSPECTOR_WIDTH = 240;
export const MAX_INSPECTOR_WIDTH = 820;
export const DEFAULT_INSPECTOR_WIDTH = 400;
export const MIN_CHAT_WIDTH = 360;
export const COLLAPSE_RESIZE_THRESHOLD = 48;

export function workLayoutForWidth(width: number): WorkLayout {
  if (width >= WIDE_WORK_MIN_WIDTH) return "wide";
  if (width >= MEDIUM_WORK_MIN_WIDTH) return "medium";
  return "narrow";
}

export function effectiveNarrowPane(
  state: WorkResponsiveState,
  routeKey: string,
  canInspect: boolean,
): NarrowWorkPane {
  if (state.narrowPaneRouteKey !== routeKey || (!canInspect && state.narrowPane === "inspector")) return "chat";
  return state.narrowPane;
}

export function resizeWork(
  state: WorkResponsiveState,
  nextLayout: WorkLayout,
  routeKey: string,
  canInspect: boolean,
  inspectorFocused: boolean,
  firstMeasurement: boolean,
  preferInspectorOnFirstMeasurement: boolean,
): WorkResponsiveState {
  if (state.layout === nextLayout) return state;
  const pane = effectiveNarrowPane(state, routeKey, canInspect);
  const wasExplicitlyOpen = canInspect && (
    (state.layout === "medium" && state.inspectorOpen)
    || (state.layout === "narrow" && (pane === "inspector" || state.inspectorOpen))
  );
  const preserveInspector = wasExplicitlyOpen
    || (canInspect && firstMeasurement && preferInspectorOnFirstMeasurement)
    || (state.layout === "wide" && canInspect && inspectorFocused);
  return {
    ...state,
    layout: nextLayout,
    ...(nextLayout === "wide" ? {
      inspectorOpen: firstMeasurement ? canInspect : preserveInspector,
    } : {}),
    ...(nextLayout === "medium" ? {
      inspectorOpen: preserveInspector,
      navigationOpen: !preserveInspector,
    } : {}),
    ...(nextLayout === "narrow" ? {
      narrowPane: "chat",
      narrowPaneRouteKey: routeKey,
    } : {}),
  };
}

