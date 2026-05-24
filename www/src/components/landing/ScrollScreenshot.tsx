"use client";

import { type CSSProperties, useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";

export function ScrollScreenshot() {
  const [progress, setProgress] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const updateProgress = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const element = wrapperRef.current;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
      const rawProgress = (viewportHeight - rect.top) / (viewportHeight * 0.55);
      setProgress(Math.max(0, Math.min(1, rawProgress)));
    });
  }, []);

  useEffect(() => {
    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    return () => {
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
      cancelAnimationFrame(rafRef.current);
    };
  }, [updateProgress]);

  const screenshotY = 60 * (1 - progress);
  const screenshotScale = 0.92 + progress * 0.08;

  return (
    <div ref={wrapperRef} className="screenshot-wrapper" style={{ "--ss-y": `${screenshotY}px`, "--ss-s": screenshotScale } as CSSProperties}>
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
