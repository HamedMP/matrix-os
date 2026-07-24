// Matrix CLI install card for the Plugins hub. Static, truthful content: the
// Homebrew formula ships in homebrew-tap/Formula/matrix.rb (install:
// "brew install finnaai/tap/matrix") and the npm fallback is the published
// "@finnaai/matrix" package (packages/sync-client). Copy uses
// navigator.clipboard, the same capability the terminal UI already relies on.
import { Check, Copy, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../design/primitives";

export const CLI_BREW_INSTALL_COMMAND = "brew install finnaai/tap/matrix";
export const CLI_NPM_INSTALL_COMMAND = "npm install -g @finnaai/matrix";

const COPY_FEEDBACK_MS = 2000;

type CopyTarget = "brew" | "npm";

function InstallCard({
  title,
  note,
  command,
  copied,
  onCopy,
  testId,
}: {
  title: string;
  note: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
  testId: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {title}
        </span>
        <Button data-testid={testId} onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code
        className="rounded-md px-2.5 py-1.5 font-mono text-xs"
        style={{ background: "var(--bg-sunken)", color: "var(--text-primary)" }}
      >
        {command}
      </code>
      <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
        {note}
      </span>
    </div>
  );
}

export function CliSection() {
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount teardown: a pending feedback reset must not fire on a gone tree.
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const handleCopy = async (target: CopyTarget, command: string): Promise<void> => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(command);
    } catch (err: unknown) {
      console.warn(
        "[plugins] clipboard copy failed:",
        err instanceof Error ? err.message : String(err),
      );
      setCopyError("Could not copy to the clipboard.");
      return;
    }
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    setCopiedTarget(target);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      setCopiedTarget(null);
    }, COPY_FEEDBACK_MS);
  };

  return (
    <>
      <div className="mb-5 flex flex-col gap-1">
        <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Matrix CLI
        </h3>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Control your Matrix computer from any terminal — sign in, sync files, open shells, and
          run agents with the <code className="font-mono">matrix</code> command.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <InstallCard
          title="Homebrew (recommended)"
          note="From the Finna tap, on macOS or Linux."
          command={CLI_BREW_INSTALL_COMMAND}
          copied={copiedTarget === "brew"}
          onCopy={() => void handleCopy("brew", CLI_BREW_INSTALL_COMMAND)}
          testId="plugins-cli-copy-brew"
        />
        <InstallCard
          title="npm"
          note="Any platform with Node.js 24 or newer."
          command={CLI_NPM_INSTALL_COMMAND}
          copied={copiedTarget === "npm"}
          onCopy={() => void handleCopy("npm", CLI_NPM_INSTALL_COMMAND)}
          testId="plugins-cli-copy-npm"
        />
      </div>

      {copyError ? (
        <p className="mt-3 text-xs" style={{ color: "var(--danger)" }}>{copyError}</p>
      ) : null}

      <div
        className="mt-4 flex items-start gap-2 rounded-xl border px-4 py-3"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <span className="mt-0.5" style={{ color: "var(--text-tertiary)" }}>
          <SquareTerminal size={14} />
        </span>
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          After installing, run <code className="font-mono">matrix login</code> to connect, then{" "}
          <code className="font-mono">matrix status</code> to verify your computer is reachable.
        </p>
      </div>
    </>
  );
}

export default CliSection;
