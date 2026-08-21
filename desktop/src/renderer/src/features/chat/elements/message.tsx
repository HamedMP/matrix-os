import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as React from "react";
import { Check, Copy, FileText, Folder } from "lucide-react";
import { cn } from "../../../lib/cn";

// Message/MessageGroup/MessageAvatar/MessageContent/MessageHeader/
// MessageFooter are vendored from shadcn/ui `message` (June 2026 chat
// components release), with shadcn theme tokens rewritten to our Operator
// design tokens (text-muted-foreground → --text-tertiary, bg-muted →
// --bg-sunken). Message owns the row layout (alignment, header, footer,
// avatar); the visible surface inside it is a Bubble (see bubble.tsx).
// Source: https://ui.shadcn.com/docs/components/base/message

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-[var(--bg-sunken)] group-has-data-[slot=message-footer]/message:-translate-y-8",
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end",
        className,
      )}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-[var(--text-tertiary)] group-has-data-[variant=ghost]/message:px-0",
        className,
      )}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-[var(--text-tertiary)] group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

type CopyFeedback = "idle" | "copied" | "failed";

function CopyAction({ text, target }: { text: string; target: string }) {
  const [feedback, setFeedback] = React.useState<CopyFeedback>("idle");
  const resetTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const resetLater = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setFeedback("idle"), 1_200);
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
      await navigator.clipboard.writeText(text);
      setFeedback("copied");
    } catch (error) {
      setFeedback("failed");
      console.warn("[desktop-chat] copy failed:", error instanceof Error ? error.name : "UnknownError");
    }
    resetLater();
  };

  const label = feedback === "copied"
    ? `Copied ${target}`
    : feedback === "failed"
      ? `Retry copying ${target}`
      : `Copy ${target}`;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={feedback === "copied" ? "Copied" : feedback === "failed" ? "Copy failed — retry" : "Copy"}
        className="inline-flex size-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: feedback === "failed" ? "var(--danger)" : "var(--text-tertiary)" }}
        onClick={() => void copy()}
      >
        {feedback === "copied" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      </button>
      <span className="sr-only" aria-live="polite">
        {feedback === "copied" ? `${target} copied` : feedback === "failed" ? `Could not copy ${target}` : ""}
      </span>
    </>
  );
}

export function MessageMetadata({
  content,
  timestamp,
  role,
}: {
  content: string;
  timestamp: number;
  role: "Assistant" | "User";
}) {
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  const isoTimestamp = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;

  return (
    <MessageFooter className="gap-1.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 motion-reduce:transition-none">
      <CopyAction text={content} target={`${role.toLowerCase()} message`} />
      {isoTimestamp ? (
        <time
          dateTime={isoTimestamp}
          aria-label={`${role} message sent at ${isoTimestamp}`}
          className="text-[11px] tabular-nums"
          style={{ color: "var(--text-tertiary)" }}
        >
          {formatMessageTime(timestamp)}
        </time>
      ) : null}
    </MessageFooter>
  );
}

const FILE_EXTENSION_PATTERN = /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,12}$/;
const RELATIVE_PATH_PATTERN = /^(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\/?$/;
const BARE_FILE_PATTERN = /^[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]{1,12}$/;

function pathPresentation(value: string): { kind: "file" | "folder"; label: string } | null {
  const normalized = value.trim();
  if (!normalized || /\s/.test(normalized)) return null;
  const looksLikePath = normalized.startsWith("/")
    || normalized.startsWith("~/")
    || normalized.startsWith("./")
    || normalized.startsWith("../")
    || RELATIVE_PATH_PATTERN.test(normalized)
    || BARE_FILE_PATTERN.test(normalized);
  if (!looksLikePath) return null;
  const withoutTrailingSlash = normalized.replace(/[\\/]+$/, "");
  const label = withoutTrailingSlash.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
  return {
    kind: FILE_EXTENSION_PATTERN.test(withoutTrailingSlash) ? "file" : "folder",
    label,
  };
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div
      className="my-3 overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
    >
      <div
        className="flex min-h-8 items-center justify-between border-b px-3 text-[11px]"
        style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
      >
        <span className="font-mono">{language}</span>
        <CopyAction text={code} target="code block" />
      </div>
      <pre className="max-h-80 overflow-x-auto p-3">
        <code className="font-mono text-xs" style={{ background: "transparent", border: 0, padding: 0 }}>{code}</code>
      </pre>
    </div>
  );
}

// Assistant messages render full-width markdown. The markdown pipeline
// (react-markdown + prose classes + data-selectable) is unchanged — it is the
// rendering engine, not layout.
export function MessageResponse({ children }: { children: string }) {
  return (
    <div
      className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded-md [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-[var(--border-subtle)] [&_li]:my-1 [&_li]:marker:text-[var(--text-tertiary)] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      style={{ color: "var(--text-primary)" }}
      data-selectable
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ node: _node, children: codeChildren, className, ...props }) => {
            const value = String(codeChildren).replace(/\n$/, "");
            const blockLanguage = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
            if (blockLanguage || String(codeChildren).endsWith("\n")) {
              return <CodeBlock code={value} language={blockLanguage ?? "text"} />;
            }
            const path = className ? null : pathPresentation(value);
            if (path) {
              const Icon = path.kind === "file" ? FileText : Folder;
              return (
                <code
                  {...props}
                  aria-label={`${path.kind === "file" ? "File" : "Folder"} path: ${path.label}`}
                  title={value}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-sunken)] px-1.5 py-0.5 align-middle font-mono text-xs"
                >
                  <Icon size={13} aria-hidden className="shrink-0" />
                  <span className="truncate">{path.label}</span>
                </code>
              );
            }
            return <code {...props} className={cn(className, "border border-[var(--border-subtle)]")}>{codeChildren}</code>;
          },
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          table: ({ node: _node, ...props }) => (
            <table
              {...props}
              className="my-3 w-full border-collapse overflow-hidden rounded-lg text-sm [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--bg-sunken)] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left"
            />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export {
  MessageGroup,
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
};
