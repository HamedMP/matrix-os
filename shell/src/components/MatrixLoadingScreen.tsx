"use client";

import { MatrixBootScreen } from "@matrix-os/brand";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

/** Same Figma presentation before and after the VPS shell becomes reachable. */
export function MatrixLoadingScreen() {
  return <MatrixBootScreen style={{ zIndex: SHELL_Z_INDEX.bootScreen }} />;
}
