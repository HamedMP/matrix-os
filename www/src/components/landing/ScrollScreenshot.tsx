"use client";

import { type CSSProperties, useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";

export function ScrollScreenshot() {
  const [scrollY, setScrollY] = useState(0);
  const rafRef = useRef(0);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setScrollY(window.scrollY));
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [onScroll]);

  const screenshotY = Math.max(0, 60 - scrollY * 0.04);
  const screenshotScale = Math.min(1, 0.92 + scrollY * 0.00008);

  return (
    <div className="screenshot-wrapper" style={{ "--ss-y": `${screenshotY}px`, "--ss-s": screenshotScale } as CSSProperties}>
      <Image src="/images/app-screenshot.jpg" alt="Matrix OS Desktop" width={1920} height={1080} className="w-full h-auto" loading="lazy" />
    </div>
  );
}

export function BodyOverflow() {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevHeight = document.body.style.height;
    document.body.style.overflow = "auto";
    document.body.style.height = "auto";
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.height = prevHeight;
    };
  }, []);
  return null;
}
