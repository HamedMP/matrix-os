"use client";

import { useEffect, useState } from "react";

export const PHONE_VIEWPORT_MAX_WIDTH = 767;

export function isPhoneViewport(width: number): boolean {
  return width <= PHONE_VIEWPORT_MAX_WIDTH;
}

export function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const update = () => setMobile(isPhoneViewport(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mobile;
}
