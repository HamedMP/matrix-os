"use client";

import { useEffect, useState } from "react";

interface WelcomeOverlayProps {
  onComplete: () => void;
}

const ENTER_MS = 3500;
const HOLD_MS = 3500;
const LEAVE_MS = 3500;

// Drop the chime at shell/public/welcome-chime.mp3 (or .wav/.ogg) — playback
// silently no-ops if the file is missing.
const AUDIO_SRC = "/welcome-chime.mp3";

const SHIMMER_GRADIENT =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 25%, #C4A265 50%, #2F392C 75%, #2F392C 100%)";

// 10s cycle — visibly slower than the 6s landing wordmark so the welcome
// moment feels more deliberate. Matches both shimmer & glow durations so the
// gradient sweep and brightness pulse stay phase-locked.
const SHIMMER_ANIMATION =
  "onboard-shimmer 10s ease-in-out infinite, onboard-glow 10s ease-in-out infinite";

export function WelcomeOverlay({ onComplete }: WelcomeOverlayProps) {
  const [opacity, setOpacity] = useState(0);
  const [transitionMs, setTransitionMs] = useState(ENTER_MS);

  useEffect(() => {
    const audio = new Audio(AUDIO_SRC);
    audio.volume = 0.55;
    audio.play().catch(() => {
      /* file missing or autoplay blocked — silent */
    });

    const raf = requestAnimationFrame(() => setOpacity(1));
    const leaveT = setTimeout(() => {
      setTransitionMs(LEAVE_MS);
      setOpacity(0);
    }, ENTER_MS + HOLD_MS);
    const doneT = setTimeout(onComplete, ENTER_MS + HOLD_MS + LEAVE_MS);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(leaveT);
      clearTimeout(doneT);
      audio.pause();
    };
  }, [onComplete]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "2.5rem",
        pointerEvents: "none",
        // Translucent cream wash + soft blur — matches the warm onboarding
        // palette (#FFFDF6 is the walkthrough screen) and gives the dark
        // logo / heading enough contrast against any desktop wallpaper.
        // Fades together with the foreground via the parent opacity.
        backgroundColor: "rgba(255, 253, 246, 0.65)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        opacity,
        transition: `opacity ${transitionMs}ms cubic-bezier(0.16, 1, 0.3, 1)`,
      }}
    >
      {/* Rabbit logo — same shimmer/glow as the landing wordmark, applied via
          CSS mask so the linear gradient sweeps across the silhouette. */}
      <div
        aria-label="Matrix OS logo"
        style={{
          width: "160px",
          height: "200px",
          WebkitMaskImage: "url('/matrix-logo.svg')",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          WebkitMaskPosition: "center",
          maskImage: "url('/matrix-logo.svg')",
          maskRepeat: "no-repeat",
          maskSize: "contain",
          maskPosition: "center",
          backgroundImage: SHIMMER_GRADIENT,
          backgroundSize: "300% 100%",
          animation: SHIMMER_ANIMATION,
        }}
      />

      <h1
        style={{
          fontFamily: "var(--font-orbitron), sans-serif",
          fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
          fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          lineHeight: 1.1,
          margin: 0,
        }}
      >
        <span
          style={{
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            color: "transparent",
            backgroundImage: SHIMMER_GRADIENT,
            backgroundSize: "300% 100%",
            animation: SHIMMER_ANIMATION,
          }}
        >
          Welcome to Matrix OS
        </span>
      </h1>
    </div>
  );
}
