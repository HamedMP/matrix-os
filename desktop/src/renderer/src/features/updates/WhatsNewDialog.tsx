import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog } from "../../design/primitives";
import { safeReleaseNotesUrlTransform } from "../../lib/markdown";
import { invoke } from "../../lib/operator";
import { useDesktopUpdate } from "../../stores/desktop-update";

function releaseDateLabel(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default function WhatsNewDialog() {
  const open = useDesktopUpdate((state) => state.whatsNewOpen);
  const release = useDesktopUpdate((state) => state.release);
  const close = useDesktopUpdate((state) => state.closeWhatsNew);

  if (!release) return null;
  const date = releaseDateLabel(release.releaseDate);

  return (
    <Dialog open={open} onClose={close} width={860} title="What's New" top="8vh">
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: "min(76vh, 680px)", minHeight: "min(520px, 84vh)" }}
      >
        <header className="flex items-start justify-between px-8 pt-7 pb-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
              What's New
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-tertiary)" }}>
              Matrix OS was updated successfully.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close What's New"
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-tertiary)" }}
            onClick={close}
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto border-t px-8 py-6" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="mb-5 flex items-center gap-2.5">
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              v{release.version}
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase"
              style={{ background: "var(--update-action-muted)", color: "var(--update-action)" }}
            >
              Latest
            </span>
            {date ? (
              <span className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
                {date}
              </span>
            ) : null}
          </div>

          <div
            data-selectable
            className="text-sm leading-6 [&_a]:font-medium [&_a]:text-[var(--accent)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-semibold [&_li]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
            style={{ color: "var(--text-secondary)" }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={safeReleaseNotesUrlTransform}
              components={{
                img: () => null,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      if (href?.startsWith("https://")) {
                        void invoke("shell:open-external", { url: href });
                      }
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {release.notes}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
