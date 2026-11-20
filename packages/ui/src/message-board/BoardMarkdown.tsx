import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Raw HTML is never rendered (react-markdown skips it) and only http(s)/mailto links survive. */
function safeBoardUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : "";
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[message-board] link validation failed", error instanceof Error ? error.name : "UnknownError");
    return "";
  }
}

export function BoardMarkdown({ text }: { text: string }) {
  return <div className="min-w-0 break-words text-[14px] leading-[1.5]" style={{ color: "var(--text-primary, var(--foreground))" }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeBoardUrl}
      components={{
        h1: ({ children }) => <p className="my-1 font-semibold first:mt-0">{children}</p>,
        h2: ({ children }) => <p className="my-1 font-semibold first:mt-0">{children}</p>,
        h3: ({ children }) => <p className="my-1 font-semibold first:mt-0">{children}</p>,
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: "var(--info-text, var(--primary))" }}>{children}</a>,
        code: ({ children }) => <code className="rounded px-1 py-0.5 font-mono text-[0.88em]" style={{ background: "var(--bg-sunken, var(--muted))" }}>{children}</code>,
        pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-lg p-2 font-mono text-[12.5px]" style={{ background: "var(--bg-sunken, var(--muted))" }}>{children}</pre>,
      }}>{text}</ReactMarkdown>
  </div>;
}
