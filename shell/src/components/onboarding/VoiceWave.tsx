"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/hooks/useOnboarding";

interface VoiceWaveProps {
  state: VoiceState;
  className?: string;
}

interface WaveLayer {
  color: string;
  glowColor: string;
  freq: number;
  speed: number;
  phase: number;
  amplitude: number;        // relative to master amplitude
  lineWidth: number;        // crisp line width
  glowWidth: number;        // blur pass width
  blurRadius: number;       // shadow blur
  opacity: number;
}

// Colors extracted from the GQ reference: amber, rust, blue-white, deep blue
const LAYERS: WaveLayer[] = [
  // Layer 0 — deep amber background glow (wide, slow, heavily blurred)
  {
    color: "rgba(180, 80, 30, 0.15)",
    glowColor: "rgba(160, 60, 20, 0.4)",
    freq: 0.003, speed: 0.008, phase: 0,
    amplitude: 1.2, lineWidth: 1, glowWidth: 28, blurRadius: 30,
    opacity: 0.6,
  },
  // Layer 1 — warm rust/red-orange (medium, moderate blur)
  {
    color: "rgba(200, 90, 40, 0.25)",
    glowColor: "rgba(180, 70, 30, 0.5)",
    freq: 0.005, speed: 0.012, phase: 1.8,
    amplitude: 0.9, lineWidth: 1.5, glowWidth: 16, blurRadius: 20,
    opacity: 0.7,
  },
  // Layer 2 — deep blue aura (medium, centered)
  {
    color: "rgba(40, 90, 180, 0.2)",
    glowColor: "rgba(30, 70, 160, 0.45)",
    freq: 0.004, speed: 0.015, phase: 3.5,
    amplitude: 0.7, lineWidth: 1, glowWidth: 20, blurRadius: 25,
    opacity: 0.55,
  },
  // Layer 3 — cool blue-white crisp line (the "hero" line)
  {
    color: "rgba(170, 200, 235, 0.7)",
    glowColor: "rgba(120, 160, 220, 0.6)",
    freq: 0.006, speed: 0.018, phase: 0.5,
    amplitude: 0.8, lineWidth: 1.5, glowWidth: 6, blurRadius: 12,
    opacity: 0.9,
  },
  // Layer 4 — faint rose/pink edge accent
  {
    color: "rgba(190, 130, 120, 0.12)",
    glowColor: "rgba(170, 110, 100, 0.3)",
    freq: 0.0035, speed: 0.010, phase: 5.2,
    amplitude: 1.0, lineWidth: 1, glowWidth: 22, blurRadius: 28,
    opacity: 0.4,
  },
];

const STATE_AMP: Record<VoiceState, { amplitude: number; speed: number }> = {
  idle:      { amplitude: 0.12, speed: 1.0 },
  listening: { amplitude: 0.25, speed: 1.2 },
  speaking:  { amplitude: 1.0,  speed: 1.6 },
  thinking:  { amplitude: 0.35, speed: 1.3 },
};

export function VoiceWave({ state, className }: VoiceWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const timeRef = useRef(0);
  const ampRef = useRef(STATE_AMP[state].amplitude);
  const speedRef = useRef(STATE_AMP[state].speed);
  const stateRef = useRef(state);

  // Keep state ref current
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    // Envelope: smooth taper at edges so waves fade to nothing
    const envelope = (x: number) => {
      const t = x / w;
      // Smooth fade over first/last 15%
      const fadeIn = Math.min(1, t / 0.15);
      const fadeOut = Math.min(1, (1 - t) / 0.15);
      return Math.min(fadeIn, fadeOut);
    };

    // Build a bezier wave path from control points
    const buildWavePath = (
      layer: WaveLayer,
      masterAmp: number,
      masterSpeed: number,
      time: number,
    ) => {
      const midY = h / 2;
      const amp = masterAmp * layer.amplitude * h * 0.28;
      const points: { x: number; y: number }[] = [];

      // Sample points along the wave
      const step = 4;
      for (let x = 0; x <= w; x += step) {
        const env = envelope(x);
        const y =
          midY +
          env *
            amp *
            (Math.sin(x * layer.freq + time * layer.speed * masterSpeed + layer.phase) +
              0.3 * Math.sin(x * layer.freq * 2.1 + time * layer.speed * masterSpeed * 1.4 + layer.phase * 1.7) +
              0.15 * Math.sin(x * layer.freq * 0.6 + time * layer.speed * masterSpeed * 0.7 + layer.phase * 0.3));
        points.push({ x, y });
      }

      // Convert to smooth bezier path
      const path = new Path2D();
      if (points.length < 2) return path;

      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length - 1; i++) {
        const cpx = (points[i].x + points[i + 1].x) / 2;
        const cpy = (points[i].y + points[i + 1].y) / 2;
        path.quadraticCurveTo(points[i].x, points[i].y, cpx, cpy);
      }
      const last = points[points.length - 1];
      path.lineTo(last.x, last.y);

      return path;
    };

    const draw = () => {
      const target = STATE_AMP[stateRef.current];
      ampRef.current += (target.amplitude - ampRef.current) * 0.04;
      speedRef.current += (target.speed - speedRef.current) * 0.04;
      timeRef.current += 1;

      const amp = ampRef.current;
      const spd = speedRef.current;
      const t = timeRef.current;

      // Trailing fade: don't fully clear — leave ghost of previous frames
      // Use the page background color (#FAFAF9) so wave blends seamlessly
      ctx.fillStyle = "rgba(250, 250, 249, 0.18)";
      ctx.fillRect(0, 0, w, h);

      // Draw each wave layer: blur pass first, then crisp line on top
      for (const layer of LAYERS) {
        const path = buildWavePath(layer, amp, spd, t);
        const layerOpacity = layer.opacity * (0.5 + amp * 0.5);

        // Pass 1: wide glow (blurred)
        ctx.save();
        ctx.globalAlpha = layerOpacity * 0.6;
        ctx.strokeStyle = layer.glowColor;
        ctx.lineWidth = layer.glowWidth * (0.6 + amp * 0.4);
        ctx.shadowColor = layer.glowColor;
        ctx.shadowBlur = layer.blurRadius * (0.5 + amp * 0.5);
        ctx.stroke(path);
        ctx.restore();

        // Pass 2: medium glow
        ctx.save();
        ctx.globalAlpha = layerOpacity * 0.8;
        ctx.strokeStyle = layer.glowColor;
        ctx.lineWidth = layer.glowWidth * 0.4;
        ctx.shadowColor = layer.glowColor;
        ctx.shadowBlur = layer.blurRadius * 0.5;
        ctx.stroke(path);
        ctx.restore();

        // Pass 3: crisp thin line on top
        ctx.save();
        ctx.globalAlpha = layerOpacity;
        ctx.strokeStyle = layer.color;
        ctx.lineWidth = layer.lineWidth;
        ctx.shadowColor = layer.color;
        ctx.shadowBlur = 4;
        ctx.stroke(path);
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
