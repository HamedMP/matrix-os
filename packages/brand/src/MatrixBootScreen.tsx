import type { CSSProperties } from "react";
import { matrixBootStyles } from "./boot-screen.js";

export function MatrixBootScreen({ label = "Matrix OS is loading", style }: {
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <main className="matrix-boot-screen" role="status" aria-live="polite" aria-label={label}
      data-matrix-loading-screen="true" style={style}>
      <style>{matrixBootStyles}</style>
      <div className="matrix-boot-mark" role="img" aria-label="Matrix OS logo" />
      <h1 className="matrix-boot-sr-only">Matrix OS</h1>
    </main>
  );
}
