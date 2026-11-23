/** Lazy loading of side-panel modules with fallbacks; see `./panel-types.ts`. */

import { type ComponentType, createElement, lazy } from "react";
import { EmptyState } from "../../../_shared/office-ui";
import type { DocsPanelProps } from "./panel-types";

export type PanelLoader = () => Promise<Record<string, unknown>>;

function fallback<P>(message: string): ComponentType<P> {
  return function PanelFallback() {
    return createElement(EmptyState, { headline: "Not available", description: message });
  };
}

/** A lazy component for a panel module, or a fallback when the module is absent, fails to load or exports no component. */
export function createPanelLoader<P extends DocsPanelProps = DocsPanelProps>(
  modules: Readonly<Record<string, PanelLoader>>,
  path: string,
  exportName: string,
  missing: string,
): ComponentType<P> {
  const load = modules[path];
  if (load === undefined) return fallback<P>(missing);
  return lazy(async () => {
    try {
      const module = await load();
      const component = module.default ?? module[exportName];
      if (typeof component === "function" || (typeof component === "object" && component !== null)) return { default: component as ComponentType<P> };
      console.warn(`docs: ${path} exports no panel component`);
    } catch (error) {
      console.warn(`docs: could not load ${path}`, error);
    }
    return { default: fallback<P>("This panel could not be loaded. Reopen Docs to try again.") };
  });
}
