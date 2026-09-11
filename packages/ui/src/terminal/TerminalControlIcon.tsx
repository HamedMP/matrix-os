import React from "react";

export type TerminalControlIconName =
  | "split-right"
  | "split-down"
  | "maximize"
  | "keyboard"
  | "more"
  | "close"
  | "left"
  | "right"
  | "up"
  | "down"
  | "history-top"
  | "history-bottom";

export function TerminalControlIcon({
  name,
}: {
  name: TerminalControlIconName;
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "split-right" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M12 4v16M15 12h3m-1.5-1.5v3" />
        </>
      )}
      {name === "split-down" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 12h18m-9 3v3m-1.5-1.5h3" />
        </>
      )}
      {name === "maximize" && <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />}
      {name === "keyboard" && (
        <>
          <rect x="2" y="5" width="20" height="14" rx="3" />
          <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8" />
        </>
      )}
      {name === "more" && (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      )}
      {name === "left" && <path d="m10 6-6 6 6 6M4 12h16" />}
      {name === "right" && <path d="m14 6 6 6-6 6M4 12h16" />}
      {name === "up" && <path d="m6 10 6-6 6 6M12 4v16" />}
      {name === "down" && <path d="m6 14 6 6 6-6M12 4v16" />}
      {name === "history-top" && <path d="M5 3h14m-13 9 6-6 6 6M12 6v15" />}
      {name === "history-bottom" && <path d="M5 21h14m-13-9 6 6 6-6M12 3v15" />}
      {name === "close" && <path d="m6 6 12 12M6 18 18 6" />}
    </svg>
  );
}
