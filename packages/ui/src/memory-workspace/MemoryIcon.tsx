export function MemoryIcon({
  name = "memory",
  size = 18,
}: {
  name?:
    | "memory"
    | "library"
    | "search"
    | "compare"
    | "activity"
    | "note"
    | "email"
    | "calendar"
    | "document"
    | "plus"
    | "chat"
    | "arrow"
    | "upload";
  size?: number;
}) {
  const paths: Record<string, string[]> = {
    memory: [
      "M12 3a7 7 0 0 0-4 12.75V19h8v-3.25A7 7 0 0 0 12 3Z",
      "M9 22h6M9 10h6M12 7v6",
    ],
    library: ["M4 4h5v16H4ZM12 4h4v16h-4ZM19 5l2 14"],
    search: ["m21 21-5-5", "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"],
    compare: ["M4 5h6v14H4ZM14 5h6v14h-6M7 2v3M17 19v3"],
    activity: ["M3 12h4l3-7 4 14 3-7h4"],
    note: ["M5 3h14v18H5Z", "M8 8h8M8 12h8M8 16h5"],
    document: ["M6 3h8l4 4v14H6Z", "M14 3v5h4M9 12h6M9 16h6"],
    email: ["M3 5h18v14H3Z", "m3 5 9 7 9-7"],
    calendar: ["M3 5h18v16H3Z", "M7 2v6M17 2v6M3 10h18M7 14h3"],
    plus: ["M12 5v14M5 12h14"],
    chat: ["M3 4h18v13H9l-6 4Z"],
    arrow: ["m14 6-6 6 6 6"],
    upload: ["M12 16V3m-5 5 5-5 5 5", "M4 15v6h16v-6"],
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {(paths[name] ?? paths.memory)!.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
