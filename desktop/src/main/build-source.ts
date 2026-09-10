import { BuildSourceSchema, type BuildSource } from "@matrix-os/contracts";

declare const __MATRIX_DESKTOP_BUILD_SOURCE__: unknown;

export function readDesktopBuildSource(): BuildSource | null {
  const parsed = BuildSourceSchema.safeParse(typeof __MATRIX_DESKTOP_BUILD_SOURCE__ === "undefined"
    ? null : __MATRIX_DESKTOP_BUILD_SOURCE__);
  return parsed.success ? parsed.data : null;
}
