"use client";

import { useEffect, useState } from "react";

interface AppSuggestionCardsProps {
  apps: { name: string; description: string }[];
}

export function AppSuggestionCards({ apps }: AppSuggestionCardsProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  if (apps.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 w-full max-w-lg">
      {apps.map((app, i) => (
        <div
          key={app.name}
          className="p-4 rounded-2xl border border-foreground/8 bg-foreground/[0.03] transition-all duration-500 ease-out"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? "translateY(0)" : "translateY(8px)",
            transitionDelay: `${i * 150}ms`,
          }}
        >
          <h3 className="text-sm font-medium text-foreground/80">{app.name}</h3>
          <p className="text-xs text-foreground/40 mt-1 leading-relaxed">{app.description}</p>
        </div>
      ))}
    </div>
  );
}
