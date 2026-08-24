export const CODING_AGENTS_DESKTOP_WORKSPACE =
  import.meta.env.VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0";

// The Electron shell now treats retained tabs as OS-like desktop surfaces.
// Keep a one-line rollback path while the new presentation is exercised in
// packaged builds and across native WebContentsView embeds.
export const NATIVE_DESKTOP_WINDOW_SHELL =
  import.meta.env.VITE_NATIVE_DESKTOP_WINDOW_SHELL !== "0";
