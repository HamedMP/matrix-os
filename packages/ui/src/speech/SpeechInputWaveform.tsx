"use client";

import { useEffect, useState } from "react";

const BAR_COUNT = 9;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 20;

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

export function SpeechInputWaveform({
  level,
  className,
}: {
  level: number;
  className?: string;
}) {
  const normalizedLevel = clampLevel(level);
  const [history, setHistory] = useState<number[]>(() => Array.from({ length: BAR_COUNT }, () => 0));

  useEffect(() => {
    setHistory((current) => [...current.slice(1), normalizedLevel]);
  }, [normalizedLevel]);

  return (
    <span
      aria-hidden="true"
      data-testid="speech-input-waveform"
      data-level={String(normalizedLevel)}
      className={className}
      style={{
        alignItems: "center",
        display: "inline-flex",
        flexShrink: 0,
        gap: 2,
        height: MAX_BAR_HEIGHT,
      }}
    >
      {history.map((sample, index) => (
        <span
          // A fixed chronological slot keeps the waveform stable while values flow left.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="motion-reduce:transition-none"
          style={{
            background: "currentColor",
            borderRadius: 999,
            display: "block",
            height: MIN_BAR_HEIGHT + Math.round(sample * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)),
            opacity: 0.45 + sample * 0.55,
            transition: "height 80ms ease-out, opacity 80ms ease-out",
            width: 2,
          }}
        />
      ))}
    </span>
  );
}
