"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, GithubIcon, MessageCircleIcon, SparklesIcon, TerminalIcon, XIcon } from "lucide-react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { createTerminalLaunchPath } from "@/lib/terminal-launch";

interface ManualSetupStickersProps {
  onOpenTerminal: (path: string) => void;
  onAskHermes: () => void;
  onClose: () => void;
}

interface StickerProps {
  id: StickerId;
  title: string;
  eyebrow: string;
  tone: "gold" | "green" | "rose" | "blue";
  rotate: string;
  x: number;
  y: number;
  spatial: boolean;
  onDragStart: (id: StickerId, event: ReactPointerEvent<HTMLElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  className?: string;
  children: ReactNode;
}

type StickerId = "agent" | "github" | "hermes" | "finish";

const DEFAULT_POSITIONS: Record<StickerId, { x: number; y: number }> = {
  agent: { x: 34, y: 0 },
  github: { x: 710, y: 40 },
  hermes: { x: 270, y: 310 },
  finish: { x: 610, y: 370 },
};
const POSITION_STORAGE_KEY = "matrix:onboarding-sticker-positions";

const tones = {
  gold: "border-[#d9b56a]/55 bg-[#fff0bd] text-[#332512] shadow-[#4b3910]/18",
  green: "border-[#93b985]/55 bg-[#dff4cf] text-[#1c3218] shadow-[#203e18]/14",
  rose: "border-[#dea2a2]/55 bg-[#ffe0df] text-[#3b1c1b] shadow-[#4a1d1a]/14",
  blue: "border-[#9ab4da]/55 bg-[#dcecff] text-[#172a43] shadow-[#1d3350]/14",
};

function readStoredPositions(): Record<StickerId, { x: number; y: number }> {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return DEFAULT_POSITIONS;
    const parsed = JSON.parse(raw) as Partial<Record<StickerId, { x: unknown; y: unknown }>>;
    return (Object.keys(DEFAULT_POSITIONS) as StickerId[]).reduce(
      (next, id) => {
        const position = parsed[id];
        next[id] =
          position &&
          typeof position.x === "number" &&
          Number.isFinite(position.x) &&
          typeof position.y === "number" &&
          Number.isFinite(position.y)
            ? { x: Number(position.x), y: Number(position.y) }
            : DEFAULT_POSITIONS[id];
        return next;
      },
      { ...DEFAULT_POSITIONS },
    );
  } catch (error) {
    console.warn("Failed to load onboarding sticker positions", error);
    return DEFAULT_POSITIONS;
  }
}

function writeStoredPositions(positions: Record<StickerId, { x: number; y: number }>) {
  try {
    window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positions));
  } catch (error) {
    console.warn("Failed to save onboarding sticker positions", error);
  }
}

function StickerButton({
  children,
  onClick,
  variant = "dark",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "dark" | "light";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      className={[
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-semibold transition hover:-translate-y-0.5 active:translate-y-0",
        variant === "dark"
          ? "bg-[#17281f] text-white shadow-[0_12px_24px_rgba(23,40,31,0.18)] hover:bg-[#213b2e]"
          : "border border-current/20 bg-white/48 text-current hover:bg-white/70",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SetupSticker({
  id,
  title,
  eyebrow,
  tone,
  rotate,
  x,
  y,
  spatial,
  onDragStart,
  onDragMove,
  onDragEnd,
  className = "",
  children,
}: StickerProps) {
  return (
    <article
      onPointerDown={(event) => onDragStart(id, event)}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      className={[
        spatial
          ? "absolute cursor-grab touch-none active:cursor-grabbing"
          : "relative cursor-default touch-auto",
        "min-h-[250px] rounded-[3px] border p-5 shadow-[0_24px_48px_var(--sticker-shadow)] backdrop-blur-[1px]",
        "before:absolute before:left-1/2 before:top-0 before:h-7 before:w-24 before:-translate-x-1/2 before:-translate-y-1/2 before:rotate-[-2deg] before:rounded-sm before:bg-white/48 before:shadow-[0_8px_18px_rgba(0,0,0,0.08)] before:content-['']",
        tones[tone],
        className,
      ].join(" ")}
      style={{
        left: spatial ? x : undefined,
        top: spatial ? y : undefined,
        transform: spatial ? `rotate(${rotate})` : "none",
        "--sticker-shadow": "rgba(0,0,0,0.12)",
      } as CSSProperties & Record<"--sticker-shadow", string>}
    >
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-current/48">{eyebrow}</p>
      <h2 className="text-[1.35rem] font-semibold leading-tight tracking-normal">{title}</h2>
      <div className="mt-4 text-sm leading-6 text-current/72">{children}</div>
    </article>
  );
}

export function ManualSetupStickers({ onOpenTerminal, onAskHermes, onClose }: ManualSetupStickersProps) {
  const [positions, setPositions] = useState(readStoredPositions);
  const [spatial, setSpatial] = useState(() => typeof window === "undefined" || window.innerWidth >= 1100);
  const positionsRef = useRef(positions);
  const dragRef = useRef<{
    id: StickerId;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    const updateSpatialLayout = () => setSpatial(window.innerWidth >= 1100);
    updateSpatialLayout();
    window.addEventListener("resize", updateSpatialLayout);
    return () => window.removeEventListener("resize", updateSpatialLayout);
  }, []);

  const onDragStart = (id: StickerId, event: ReactPointerEvent<HTMLElement>) => {
    if (!spatial || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: positions[id].x,
      originY: positions[id].y,
    };
  };

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const zoom = useCanvasTransform.getState().zoom || 1;
    const maxX = Math.max(900, window.innerWidth - 60);
    const maxY = Math.max(540, window.innerHeight - 80);
    const nextX = Math.max(-40, Math.min(maxX, drag.originX + (event.clientX - drag.startX) / zoom));
    const nextY = Math.max(-20, Math.min(maxY, drag.originY + (event.clientY - drag.startY) / zoom));
    setPositions((prev) => {
      const next = { ...prev, [drag.id]: { x: nextX, y: nextY } };
      positionsRef.current = next;
      return next;
    });
  };

  const onDragEnd = () => {
    if (dragRef.current) {
      writeStoredPositions(positionsRef.current);
    }
    dragRef.current = null;
  };

  const dragProps = { onDragStart, onDragMove, onDragEnd };

  return (
    <div
      className={
        spatial
          ? "pointer-events-none absolute left-0 top-0 z-0 h-[720px] w-[1080px]"
          : "pointer-events-none absolute left-3 right-3 top-16 z-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6"
      }
    >
      <div className={spatial ? "relative h-full w-full" : "grid max-w-[420px] gap-4"}>
        <div className={spatial ? "pointer-events-auto absolute left-[960px] top-[-42px]" : "pointer-events-auto flex justify-end"}>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-10 items-center justify-center rounded-full border border-[#17281f]/12 bg-white/72 text-[#17281f] shadow-[0_16px_40px_rgba(23,40,31,0.16)] backdrop-blur-md transition hover:bg-white"
            aria-label="Close setup notes"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        <SetupSticker
          id="agent"
          eyebrow="1. agent login"
          title="Bring your own agent"
          tone="gold"
          rotate="-1.8deg"
          x={positions.agent.x}
          y={positions.agent.y}
          spatial={spatial}
          className="pointer-events-auto w-full max-w-[360px]"
          {...dragProps}
        >
          <p>
            Matrix is bring-your-own-agent. Sign in to Claude, Codex, or any agent you trust for specialist work.
            Hermes keeps Matrix useful even when no external agent is connected.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <StickerButton onClick={() => onOpenTerminal(createTerminalLaunchPath("claude-login"))}>
              <TerminalIcon className="size-4" aria-hidden="true" />
              Open Claude login
            </StickerButton>
            <StickerButton variant="light" onClick={() => onOpenTerminal(createTerminalLaunchPath("codex-login"))}>
              <SparklesIcon className="size-4" aria-hidden="true" />
              Open Codex login
            </StickerButton>
          </div>
        </SetupSticker>

        <SetupSticker
          id="github"
          eyebrow="2. code access"
          title="Connect GitHub with SSH"
          tone="green"
          rotate="1.4deg"
          x={positions.github.x}
          y={positions.github.y}
          spatial={spatial}
          className="pointer-events-auto w-full max-w-[350px]"
          {...dragProps}
        >
          <p>
            Use this if Matrix should work inside repositories. Pick GitHub.com, SSH, then browser login when the
            terminal asks. SSH keeps coding sessions clean on your VPS.
          </p>
          <div className="mt-5">
            <StickerButton onClick={() => onOpenTerminal(createTerminalLaunchPath("github-ssh-login"))}>
              <GithubIcon className="size-4" aria-hidden="true" />
              Run gh auth login
            </StickerButton>
          </div>
        </SetupSticker>

        <SetupSticker
          id="hermes"
          eyebrow="3. everyday help"
          title="Ask Hermes anything"
          tone="blue"
          rotate="-0.7deg"
          x={positions.hermes.x}
          y={positions.hermes.y}
          spatial={spatial}
          className="pointer-events-auto w-full max-w-[360px]"
          {...dragProps}
        >
          <p>
            Hermes is the assistant for normal Matrix work: build an app, summarize emails, read context, create a
            calendar event, or explain what Matrix can do next.
          </p>
          <div className="mt-5">
            <StickerButton onClick={onAskHermes}>
              <MessageCircleIcon className="size-4" aria-hidden="true" />
              Open Hermes
            </StickerButton>
          </div>
        </SetupSticker>

        <SetupSticker
          id="finish"
          eyebrow="4. finish later"
          title="Keep moving"
          tone="rose"
          rotate="2deg"
          x={positions.finish.x}
          y={positions.finish.y}
          spatial={spatial}
          className="pointer-events-auto w-full max-w-[330px]"
          {...dragProps}
        >
          <p>
            These notes are optional. Close them when your workspace feels ready; reset onboarding from the VM banner
            any time you want to replay the first-run flow.
          </p>
          <div className="mt-5">
            <StickerButton variant="light" onClick={onClose}>
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              Done for now
            </StickerButton>
          </div>
        </SetupSticker>
      </div>
    </div>
  );
}
