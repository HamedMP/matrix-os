"use client";

export const MOBILE_TERMINAL_INPUT_ACTIVE_EVENT = "matrixos:terminal-input-active";

export interface MobileTerminalInputActiveDetail {
  active: boolean;
  terminalId: string;
}
