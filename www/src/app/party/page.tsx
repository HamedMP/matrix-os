import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "lucide-react";
import { WaitlistButton } from "./waitlist-button";

export const metadata: Metadata = {
  title: "Matrix OS | Claude Code Birthday Party",
  description:
    "Matrix OS: the AI operating system where software writes itself. Featured at Claude Code's 1st Birthday Party.",
  openGraph: {
    title: "Matrix OS at Claude Code's Birthday Party",
    description:
      "The OS that builds itself. Featured at Claude Code's 1st Birthday Party in SF.",
    url: "https://matrix-os.com/party",
  },
};

const QR_SITE =
  "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https%3A%2F%2Fmatrix-os.com&format=svg&margin=0&color=1c1917";
const QR_X =
  "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https%3A%2F%2Fx.com%2Fhamedmp&format=svg&margin=0&color=1c1917";

const VIDEO_ID = "9ScmvifjV9s";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function PartyPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Minimal top bar */}
      <nav className="px-6 pt-5 pb-2">
        <div className="mx-auto max-w-4xl flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 group">
            <img
              src="/logo.png"
              alt="Matrix OS"
              className="size-7 rounded-lg shadow-sm"
            />
            <span className="text-sm font-semibold tracking-tight">
              Matrix OS
            </span>
          </a>
          <Badge
            variant="outline"
            className="border-primary/30 bg-card/80 text-primary font-mono text-[10px] tracking-[0.2em] uppercase backdrop-blur-sm py-1 px-3"
          >
            Claude Code Birthday
          </Badge>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-6 py-6 sm:py-4">
        <div className="w-full max-w-4xl">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-8 md:gap-10 items-start">

            {/* Left: video + info */}
            <div>
              {/* Headline */}
              <div className="mb-5">
                <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-[1.1] mb-2">
                  The OS that{" "}
                  <span className="font-[family-name:var(--font-caveat)] text-primary text-[1.15em]">
                    builds itself.
                  </span>
                </h1>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
                  Describe what you need. Watch it appear. Everything is a file you own.
                </p>
              </div>

              {/* Video */}
              <div className="rounded-2xl overflow-hidden border border-border bg-card shadow-lg aspect-video mb-5">
                <iframe
                  src={`https://www.youtube.com/embed/${VIDEO_ID}?rel=0&modestbranding=1`}
                  title="Matrix OS Demo"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-full"
                />
              </div>

              {/* Stats */}
              <div className="flex flex-wrap gap-2 mb-5">
                {["1,012 Tests", "6 Agents", "26 Tools", "20 Skills", "Opus 4.6"].map(
                  (stat) => (
                    <span
                      key={stat}
                      className="text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 rounded-full border border-border bg-card/80 text-muted-foreground"
                    >
                      {stat}
                    </span>
                  )
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap gap-3">
                <WaitlistButton />
                <Button
                  variant="outline"
                  size="lg"
                  className="h-10 px-5 text-sm rounded-xl bg-card/60 backdrop-blur-sm"
                  asChild
                >
                  <a
                    href="https://github.com/HamedMP/matrix-os"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <GithubIcon className="size-4" />
                    Star on GitHub
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-10 px-5 text-sm rounded-xl bg-card/60 backdrop-blur-sm"
                  asChild
                >
                  <a href="/whitepaper">Whitepaper</a>
                </Button>
              </div>
            </div>

            {/* Right: QR codes + contact */}
            <div className="flex flex-col items-center gap-6">
              {/* Site QR */}
              <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-5 text-center w-full">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">
                  Website
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={QR_SITE}
                  alt="QR: matrix-os.com"
                  width={148}
                  height={148}
                  className="mx-auto mb-2.5"
                />
                <p className="text-xs text-muted-foreground font-mono">
                  matrix-os.com
                </p>
              </div>

              {/* X QR */}
              <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-5 text-center w-full">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3 flex items-center justify-center gap-1.5">
                  <XIcon className="size-3 fill-current" />
                  Follow / DM
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={QR_X}
                  alt="QR: x.com/hamedmp"
                  width={128}
                  height={128}
                  className="mx-auto mb-2.5"
                />
                <p className="text-xs text-muted-foreground font-mono">
                  @hamedmp
                </p>
              </div>

              {/* Built by */}
              <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-4 text-center w-full">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-mono mb-2">
                  Built by
                </p>
                <p className="text-sm font-semibold mb-1">Hamed</p>
                <a
                  href="https://x.com/hamedmp"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <XIcon className="size-3 fill-current" />
                  @hamedmp
                </a>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-3 text-center">
        <p className="text-[10px] text-muted-foreground/50">
          Featured at Claude Code&apos;s 1st Birthday Party &middot; SF &middot; Feb 2026
        </p>
      </footer>
    </div>
  );
}
