import React, { Component, type ComponentType, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrandCard, MatrixBootScreen } from "@matrix-os/brand";
import { desktopPalette, palette } from "@matrix-os/brand/tokens";
import { Button } from "@matrix-os/ui/button";
import { desktopQueryClient } from "./lib/query-client";

function reportStartupError(error: unknown): void {
  console.error("[renderer] failed to start:", error instanceof Error ? error.name : "UnknownError");
}

function RendererRecovery({ reload }: { reload: () => void }) {
  return (
    <main className="flex h-full items-center justify-center p-6" style={{ background: desktopPalette.paper, color: palette.brandInk }}>
      <BrandCard className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <h1 className="text-xl font-semibold">Matrix OS couldn’t open this window</h1>
        <p>Reload the window to try again.</p>
        <Button onClick={reload}>Reload window</Button>
      </BrandCard>
    </main>
  );
}

class RendererBoundary extends Component<{ children: ReactNode; reload: () => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    reportStartupError(error);
  }

  override render() {
    return this.state.failed ? <RendererRecovery reload={this.props.reload} /> : this.props.children;
  }
}

/** Keep both native roots visible while loading, and recover failed imports or
 * render/effect errors without replaying requests or touching owner data. */
export function startDesktopRenderer(options: {
  container: HTMLElement;
  loadRoot: () => Promise<{ default: ComponentType }>;
  reload?: () => void;
}): () => void {
  const root = ReactDOM.createRoot(options.container);
  const reload = options.reload ?? (() => window.location.reload());
  let active = true;
  root.render(<MatrixBootScreen label="Opening Matrix OS" />);

  void Promise.resolve().then(options.loadRoot).then(({ default: Root }) => {
    if (!active) return;
    root.render(
      <React.StrictMode>
        <RendererBoundary reload={reload}>
          <QueryClientProvider client={desktopQueryClient}>
            <Root />
          </QueryClientProvider>
        </RendererBoundary>
      </React.StrictMode>,
    );
  }).catch((error: unknown) => {
    reportStartupError(error);
    if (active) root.render(<RendererRecovery reload={reload} />);
  });

  return () => {
    active = false;
    root.unmount();
  };
}
