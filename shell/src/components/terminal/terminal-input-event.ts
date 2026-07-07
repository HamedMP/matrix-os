"use client";

export const TERMINAL_INPUT_EVENT = "matrix-os:terminal-input";

export interface TerminalInputEventDetail {
  paneId: string;
  data?: string;
  action?: "input" | "paste" | "search";
  submit?: boolean;
}
