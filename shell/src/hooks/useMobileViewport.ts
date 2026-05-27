"use client";

import { useEffect, useState } from "react";

export const PHONE_VIEWPORT_MAX_WIDTH = 767;

export function isPhoneViewport(width: number): boolean {
  return width <= PHONE_VIEWPORT_MAX_WIDTH;
}

/**
 * Reads the current viewport synchronously on the client so the first paint
 * already renders the correct shell (Desktop vs MobileShell) without a flash.
 *
 * Returns `false` during SSR — the server doesn't know the device, so it
 * picks Desktop. The lazy initialiser then runs on the first client render
 * (before paint) and corrects to the real viewport size, avoiding the
 * post-hydration flicker that the useEffect-only version produced.
 */
export function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return isPhoneViewport(window.innerWidth);
  });

  useEffect(() => {
    const update = () => setMobile(isPhoneViewport(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mobile;
}
