export function initialsForOrganization(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "O";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
}

export function OrganizationMark({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[7px] font-medium tracking-[-0.02em]"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.5)),
        background: "#718f55",
        color: "#fff",
      }}
    >
      {name.trim().slice(0, 1).toUpperCase() || "O"}
    </span>
  );
}
