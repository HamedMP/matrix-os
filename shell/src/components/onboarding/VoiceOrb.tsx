"use client";

import type { VoiceState } from "@/hooks/useOnboarding";

interface VoiceOrbProps {
  state: VoiceState;
  size?: number;
}

const STATE_STYLES: Record<VoiceState, { color: string; scale: number; pulse: boolean }> = {
  idle: { color: "rgba(140, 199, 190, 0.3)", scale: 1, pulse: false },
  listening: { color: "rgba(140, 199, 190, 0.6)", scale: 1.05, pulse: true },
  speaking: { color: "rgba(140, 199, 190, 1)", scale: 1.1, pulse: true },
  thinking: { color: "rgba(234, 179, 8, 0.6)", scale: 0.95, pulse: true },
};

export function VoiceOrb({ state, size = 160 }: VoiceOrbProps) {
  const style = STATE_STYLES[state];

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Outer glow */}
      <div
        className="absolute rounded-full transition-all duration-500 ease-out"
        style={{
          width: size * 1.4,
          height: size * 1.4,
          background: `radial-gradient(circle, ${style.color} 0%, transparent 70%)`,
          transform: `scale(${style.scale})`,
          animation: style.pulse ? "orb-pulse 2s ease-in-out infinite" : "none",
        }}
      />

      {/* Middle ring */}
      <div
        className="absolute rounded-full transition-all duration-300 ease-out"
        style={{
          width: size * 0.85,
          height: size * 0.85,
          background: `radial-gradient(circle at 40% 40%, rgba(255,255,255,0.15) 0%, transparent 60%)`,
          border: `2px solid ${style.color}`,
          transform: `scale(${style.scale})`,
          animation: style.pulse ? "orb-pulse 2s ease-in-out infinite 0.3s" : "none",
        }}
      />

      {/* Core orb */}
      <div
        className="absolute rounded-full transition-all duration-200 ease-out"
        style={{
          width: size * 0.5,
          height: size * 0.5,
          background: `radial-gradient(circle at 35% 35%, rgba(255,255,255,0.3) 0%, ${style.color} 60%, rgba(0,0,0,0.2) 100%)`,
          boxShadow: `0 0 ${size * 0.3}px ${style.color}, inset 0 0 ${size * 0.15}px rgba(255,255,255,0.2)`,
          transform: `scale(${style.scale})`,
        }}
      />

      {/* State label */}
      <div className="absolute -bottom-8 text-xs text-muted-foreground font-medium capitalize">
        {state === "idle" ? "ready" : state}
      </div>

      <style jsx>{`
        @keyframes orb-pulse {
          0%, 100% { opacity: 1; transform: scale(${style.scale}); }
          50% { opacity: 0.7; transform: scale(${style.scale * 1.08}); }
        }
      `}</style>
    </div>
  );
}
