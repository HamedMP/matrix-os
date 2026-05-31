"use client";

import { useEffect, useState } from "react";

export const PHONE_VIEWPORT_MAX_WIDTH = 767;

export function isPhoneViewport(width: number): boolean {
  return width <= PHONE_VIEWPORT_MAX_WIDTH;
}

export function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(() => (
    typeof window !== "undefined" && isPhoneViewport(window.innerWidth)
  ));

  useEffect(() => {
    const update = () => setMobile(isPhoneViewport(window.innerWidth));
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- the useState above already lazy-inits from window.innerWidth; this mount-time update() is a deliberate re-sync that closes the gap between the render snapshot and effect commit (the viewport can change before the resize listener is attached), not a substitute for a lazy initializer
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mobile;
}
