"use client";

import { useEffect, useRef, useCallback } from "react";
import { create } from "zustand";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";

interface DotGridStore {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (v: boolean) => void;
}

export const useDotGrid = create<DotGridStore>()((set) => ({
  enabled: true,
  toggle: () => set((s) => ({ enabled: !s.enabled })),
  setEnabled: (v) => set({ enabled: v }),
}));

const BASE_SPACING = 28;
const DOT_RADIUS = 1.2;
const GLOW_RADIUS = 120;
const IDLE_FADE_MS = 2000;
const MIN_SCREEN_SPACING = 14;

export function DotGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabled = useDotGrid((s) => s.enabled);
  const mouseRef = useRef({ x: -1000, y: -1000, active: false });
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rafRef = useRef(0);
  const prevTimeRef = useRef(0);
  const glowOpacityRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  const drawPendingRef = useRef(false);

  const syncSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    sizeRef.current = { w, h };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    syncSize();
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;

    ctx.clearRect(0, 0, w, h);

    const { zoom, panX, panY } = useCanvasTransform.getState();

    const mx = mouseRef.current.x;
    const my = mouseRef.current.y;
    const glowOp = glowOpacityRef.current;

    // Adaptive spacing: double grid level when screen dots get too dense
    let level = 1;
    while (BASE_SPACING * zoom * level < MIN_SCREEN_SPACING) level *= 2;
    const canvasSpacing = BASE_SPACING * level;
    const screenSpacing = canvasSpacing * zoom;

    // Visible canvas rect (what part of infinite canvas is on screen)
    const canvasLeft = -panX;
    const canvasTop = -panY;
    const canvasRight = w / zoom - panX;
    const canvasBottom = h / zoom - panY;

    // Grid-aligned range
    const startCol = Math.floor(canvasLeft / canvasSpacing);
    const startRow = Math.floor(canvasTop / canvasSpacing);
    const endCol = Math.ceil(canvasRight / canvasSpacing);
    const endRow = Math.ceil(canvasBottom / canvasSpacing);

    // Fade dots near the density threshold so level transitions aren't jarring
    const fadeRatio = (screenSpacing - MIN_SCREEN_SPACING) / MIN_SCREEN_SPACING;
    const baseAlpha = 0.45 * Math.max(0.4, Math.min(1, fadeRatio));

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        // Canvas-space position
        const cx = col * canvasSpacing;
        const cy = row * canvasSpacing;
        // Convert to screen-space
        const sx = (cx + panX) * zoom;
        const sy = (cy + panY) * zoom;

        let alpha = baseAlpha;
        let radius = DOT_RADIUS;

        if (glowOp > 0.01) {
          const dx = sx - mx;
          const dy = sy - my;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < GLOW_RADIUS) {
            const t = 1 - dist / GLOW_RADIUS;
            alpha += t * 0.4 * glowOp;
            radius += t * 0.7 * glowOp;
          }
        }

        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(140, 130, 160, ${alpha})`;
        ctx.fill();
      }
    }

    // Cursor glow halo
    if (glowOp > 0.01) {
      const gradient = ctx.createRadialGradient(mx, my, 0, mx, my, GLOW_RADIUS);
      gradient.addColorStop(0, `rgba(194, 160, 120, ${0.07 * glowOp})`);
      gradient.addColorStop(0.6, `rgba(194, 160, 120, ${0.025 * glowOp})`);
      gradient.addColorStop(1, "rgba(194, 160, 120, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(mx, my, GLOW_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    drawPendingRef.current = false;
  }, [syncSize]);

  const animate = useCallback(
    (time: number) => {
      const dt = prevTimeRef.current ? time - prevTimeRef.current : 16;
      prevTimeRef.current = time;

      if (mouseRef.current.active) {
        glowOpacityRef.current = Math.min(1, glowOpacityRef.current + dt / 300);
      } else {
        glowOpacityRef.current = Math.max(0, glowOpacityRef.current - dt / 600);
      }

      draw();

      if (glowOpacityRef.current > 0.01 || mouseRef.current.active) {
        rafRef.current = requestAnimationFrame(animate);
      }
    },
    [draw],
  );

  const startAnimating = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animate);
  }, [animate]);

  const scheduleStaticDraw = useCallback(() => {
    if (drawPendingRef.current) return;
    drawPendingRef.current = true;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      draw();
      if (glowOpacityRef.current > 0.01) {
        rafRef.current = requestAnimationFrame(animate);
      }
    });
  }, [draw, animate]);

  useEffect(() => {
    if (!enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      syncSize();
      draw();
    });
    ro.observe(canvas);

    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        mouseRef.current.active = false;
        startAnimating();
      }, IDLE_FADE_MS);
      startAnimating();
    };

    const onLeave = () => {
      mouseRef.current.active = false;
      clearTimeout(idleTimerRef.current);
      startAnimating();
    };

    // Redraw when canvas transform changes (zoom/pan)
    const unsubTransform = useCanvasTransform.subscribe(() => scheduleStaticDraw());

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseleave", onLeave);

    return () => {
      ro.disconnect();
      unsubTransform();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(rafRef.current);
      clearTimeout(idleTimerRef.current);
    };
  }, [enabled, draw, syncSize, startAnimating, scheduleStaticDraw]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width: "100%", height: "100%", zIndex: 0 }}
    />
  );
}
