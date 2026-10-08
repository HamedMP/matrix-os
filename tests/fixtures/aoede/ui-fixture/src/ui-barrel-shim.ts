/**
 * Narrow stand-in for the `@matrix-os/ui` barrel used by the pulled shell
 * modules (`useWindowManager` imports `constrainFloatingWindow`). The real
 * barrel would drag the entire component library — providers, collaboration,
 * file preview — into the fixture graph for a single placement helper. The
 * Aoede subpath alias (`@matrix-os/ui/aoede`) still resolves to the real
 * module; only the bare specifier lands here.
 */
export {
  constrainFloatingWindow,
  isPointNearWindow,
  WINDOW_BACKGROUND_CLICK_BUFFER,
} from "../../../../../packages/ui/src/window/window-placement";
export type { WindowBounds } from "../../../../../packages/ui/src/window/WindowResizeControls";
