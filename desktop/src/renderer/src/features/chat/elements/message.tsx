import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";

// AI-Elements-style Message: user messages sit in a secondary bubble aligned
// right; assistant messages render full-width markdown.
export function Message({ from, children }: { from: "user" | "assistant" | "system"; children: ReactNode }) {
  if (from === "user") {
    return <div className="flex justify-end">{children}</div>;
  }
  return <div className="flex flex-col gap-2">{children}</div>;
}

export function MessageContent({ from, children }: { from: "user" | "assistant" | "system"; children: ReactNode }) {
  if (from === "user") {
    return (
      <div
        className="max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap"
        style={{ background: "var(--bg-sunken)", color: "var(--text-primary)" }}
        data-selectable
      >
        {children}
      </div>
    );
  }
  return <div className="flex flex-col gap-2">{children}</div>;
}

export function MessageResponse({ children }: { children: string }) {
  return (
    <div
      className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--bg-sunken)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
      style={{ color: "var(--text-primary)" }}
      data-selectable
    >
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
