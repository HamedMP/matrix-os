"use client";

import { useSyncExternalStore } from "react";

export const PHONE_VIEWPORT_MAX_WIDTH = 767;

export function isPhoneViewport(width: number): boolean {
  return width <= PHONE_VIEWPORT_MAX_WIDTH;
}

function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

function getViewportSnapshot(): boolean {
  return typeof window !== "undefined" && isPhoneViewport(window.innerWidth);
}

function getViewportServerSnapshot(): boolean {
  return false;
}

export function useMobileViewport(): boolean {
  return useSyncExternalStore(
    subscribeViewport,
    getViewportSnapshot,
    getViewportServerSnapshot,
  );
}
