"use client";

import { useState, useEffect } from "react";

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function AmbientClock({ onSwitchMode }: { onSwitchMode: () => void }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      setNow(new Date());
      const interval = setInterval(() => setNow(new Date()), 60_000);
      return () => clearInterval(interval);
    }, ms);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-6xl font-light text-foreground tracking-tight">
          {formatTime(now)}
        </p>
        <p className="text-lg text-muted-foreground mt-2">
          {formatDate(now)}
        </p>
        <button
          onClick={onSwitchMode}
          className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors mt-4"
        >
          Switch mode
        </button>
      </div>
    </div>
  );
}
