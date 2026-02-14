"use client";

interface AppTileProps {
  name: string;
  isOpen: boolean;
  onClick: () => void;
}

export function AppTile({ name, isOpen, onClick }: AppTileProps) {
  const initial = name.charAt(0).toUpperCase();

  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 p-3 rounded-xl hover:bg-accent/50 transition-colors group"
    >
      <div
        className={`flex size-14 items-center justify-center rounded-2xl border shadow-sm text-lg font-semibold transition-all ${
          isOpen
            ? "bg-primary/10 border-primary/40 text-primary shadow-primary/20 shadow-md"
            : "bg-card border-border/60 text-foreground group-hover:shadow-md"
        }`}
      >
        {initial}
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-[80px]">
        {name}
      </span>
      {isOpen && (
        <span className="size-1.5 rounded-full bg-primary -mt-0.5" />
      )}
    </button>
  );
}
