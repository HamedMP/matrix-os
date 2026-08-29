import { ExternalLink, Globe2 } from "@renderer/lib/hugeicons";
import { type FormEvent, useState } from "react";
import { resolveBrowserAddress } from "../../../../shared/runtime-browser-url";
import EmbedHost from "../embeds/EmbedHost";

export default function BrowserTab({
  active,
  layoutRevision,
  visualScale = 1,
}: {
  active: boolean;
  layoutRevision?: string;
  visualScale?: number;
}) {
  const [address, setAddress] = useState("");
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const resolved = resolveBrowserAddress(address);
    if (!resolved) {
      setMessage("Enter a web address or a runtime port such as 127.0.0.1:3000.");
      return;
    }
    setMessage(null);
    setAddress(resolved.url);
    setBrowserUrl(resolved.url);
    setNavigationRevision((revision) => revision + 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-app)" }}>
      <form
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        onSubmit={navigate}
      >
        <Globe2 size={15} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
        <input
          aria-label="Browser address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Search or enter 127.0.0.1:3000"
          className="h-8 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            color: "var(--text-primary)",
            background: "var(--bg-app)",
            borderColor: "var(--border-default)",
          }}
        />
        <button
          type="submit"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
          style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
        >
          <ExternalLink size={13} aria-hidden="true" />
          Go
        </button>
      </form>
      {browserUrl ? (
        <EmbedHost
          key={`${browserUrl}:${navigationRevision}`}
          kind="browser"
          url={browserUrl}
          active={active}
          layoutRevision={layoutRevision}
          visualScale={visualScale}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span
            className="flex size-14 items-center justify-center rounded-2xl"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            <Globe2 size={26} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Browser</h2>
            <p className="mt-1 max-w-md text-sm" style={{ color: "var(--text-secondary)" }}>
              Browse public websites normally. Runtime localhost ports stay inside Matrix through the selected computer.
            </p>
          </div>
          {message ? <p role="status" className="text-xs" style={{ color: "var(--text-tertiary)" }}>{message}</p> : null}
        </div>
      )}
    </div>
  );
}
