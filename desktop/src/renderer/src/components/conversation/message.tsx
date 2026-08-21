import { Check, Copy, FileText, Folder, WrapText } from "lucide-react";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";
import type { ConversationPresentationCallbacks } from "./presentation";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-group" className={cn("flex min-w-0 flex-col gap-2", className)} {...props} />;
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
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

type CopyFeedback = "idle" | "copied" | "failed";

export function CopyAction({
  text,
  target,
  copyText,
  className,
}: {
  text: string | (() => string);
  target: string;
  copyText: ConversationPresentationCallbacks["copyText"];
  className?: string;
}) {
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
      await copyText(typeof text === "function" ? text() : text);
      setFeedback("copied");
    } catch (error) {
      setFeedback("failed");
      console.warn("[conversation] copy failed:", error instanceof Error ? error.name : "UnknownError");
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
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
          className,
        )}
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
  copyText,
}: {
  content: string;
  timestamp: number;
  role: "Assistant" | "User";
  copyText: ConversationPresentationCallbacks["copyText"];
}) {
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  const isoTimestamp = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;

  return (
    <MessageFooter className="gap-1.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 motion-reduce:transition-none">
      <CopyAction text={content} target={`${role.toLowerCase()} message`} copyText={copyText} />
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
  return { kind: FILE_EXTENSION_PATTERN.test(withoutTrailingSlash) ? "file" : "folder", label };
}

function CodeBlock({
  code,
  language,
  copyText,
}: {
  code: string;
  language: string;
  copyText: ConversationPresentationCallbacks["copyText"];
}) {
  const [wrapped, setWrapped] = React.useState(false);
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
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={wrapped ? "Disable code wrapping" : "Wrap code block"}
            title={wrapped ? "Disable wrapping" : "Wrap code"}
            aria-pressed={wrapped}
            className="inline-flex size-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            style={{ color: wrapped ? "var(--text-primary)" : "var(--text-tertiary)" }}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapText size={13} aria-hidden />
          </button>
          <CopyAction text={code} target="code block" copyText={copyText} />
        </span>
      </div>
      <pre className={cn("max-h-80 overflow-x-auto p-3", wrapped && "whitespace-pre-wrap wrap-break-word")}>
        <code className="font-mono text-xs" style={{ background: "transparent", border: 0, padding: 0 }}>{code}</code>
      </pre>
    </div>
  );
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function tableToMarkdown(table: HTMLTableElement | null): string {
  if (!table) return "";
  const rows = Array.from(table.rows).map((row) => (
    Array.from(row.cells).map((cell) => escapeMarkdownCell(cell.textContent ?? ""))
  ));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const lines = normalized.map((row) => `| ${row.join(" | ")} |`);
  lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  return lines.join("\n");
}

function MarkdownTable({
  copyText,
  ...props
}: React.ComponentProps<"table"> & { copyText: ConversationPresentationCallbacks["copyText"] }) {
  const tableRef = React.useRef<HTMLTableElement>(null);
  return (
    <div
      className="group/table my-3 overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div
        className="flex min-h-8 items-center justify-end border-b px-2 opacity-0 transition-opacity group-hover/table:opacity-100 group-focus-within/table:opacity-100"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        <CopyAction text={() => tableToMarkdown(tableRef.current)} target="table as Markdown" copyText={copyText} />
      </div>
      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          {...props}
          className="w-full border-collapse text-sm [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--bg-sunken)] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left"
        />
      </div>
    </div>
  );
}

export function MessageResponse({
  children,
  copyText,
}: {
  children: string;
  copyText: ConversationPresentationCallbacks["copyText"];
}) {
  return (
    <div
      className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded-md [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-[var(--border-subtle)] [&_li]:my-1 [&_li]:marker:text-[var(--text-tertiary)] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      style={{ color: "var(--text-primary)" }}
      data-selectable
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            const external = typeof href === "string" && /^https?:\/\//i.test(href);
            return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...props} />;
          },
          code: ({ node: _node, children: codeChildren, className, ...props }) => {
            const value = String(codeChildren).replace(/\n$/, "");
            const blockLanguage = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
            if (blockLanguage || String(codeChildren).endsWith("\n")) {
              return <CodeBlock code={value} language={blockLanguage ?? "text"} copyText={copyText} />;
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
          input: ({ node: _node, checked, ...props }) => (
            <input
              {...props}
              type="checkbox"
              checked={Boolean(checked)}
              disabled
              readOnly
              aria-label={checked ? "Completed task" : "Incomplete task"}
            />
          ),
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          table: ({ node: _node, ...props }) => <MarkdownTable {...props} copyText={copyText} />,
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
