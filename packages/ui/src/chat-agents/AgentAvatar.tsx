const palettes = [
  ["#6D5EF7", "#DCD8FF"],
  ["#147D78", "#C8F0EA"],
  ["#C2592A", "#FFE0C7"],
  ["#9A3E67", "#FFD8E8"],
  ["#3466A8", "#D5E7FF"],
] as const;

function stableAvatarNumber(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

export function AgentAvatar({ id, name, size = "large" }: { id: string; name: string; size?: "small" | "large" }) {
  const hash = stableAvatarNumber(id);
  const [ink, background] = palettes[hash % palettes.length]!;
  const className = size === "small" ? "h-8 w-8" : "h-12 w-12";
  const eyeOffset = hash % 3;
  return <span data-agent-avatar={id} title={name} className={`${className} relative inline-flex shrink-0 overflow-hidden rounded-full shadow-sm ring-1 ring-black/5`}
    style={{ background }} aria-hidden="true">
    <svg viewBox="0 0 48 48" className="h-full w-full" focusable="false">
      <path d={hash % 2 ? "M8 31c0-12 7-21 16-21s16 9 16 21v9H8z" : "M7 38 12 12l12-5 12 5 5 26z"} fill={ink} />
      <circle cx={18 - eyeOffset} cy="24" r="3.5" fill="white" />
      <circle cx={31 - eyeOffset} cy="24" r="3.5" fill="white" />
      <circle cx={18 - eyeOffset} cy="24" r="1.5" fill="#171717" />
      <circle cx={31 - eyeOffset} cy="24" r="1.5" fill="#171717" />
      {hash % 3 === 0 ? <path d="M17 32c4 3 10 3 14 0" fill="none" stroke="white" strokeLinecap="round" strokeWidth="2" /> : null}
      {hash % 3 === 1 ? <path d="M25 4v7M20 6h10" fill="none" stroke={ink} strokeLinecap="round" strokeWidth="2.5" /> : null}
    </svg>
  </span>;
}
