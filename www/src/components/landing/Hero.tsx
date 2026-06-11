import { ArrowRightIcon } from "lucide-react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { palette as c, cardShadow, fonts } from "./theme";
import { CtaButton, SectionShell } from "./primitives";

export function Hero() {
  return (
    <SectionShell className="pt-10 md:pt-16">
      <div className="mx-auto flex max-w-[56rem] flex-col items-center text-center">
        <h1
          className="text-[2.75rem] leading-[1.05] tracking-[-0.01em] md:text-[4.25rem]"
          style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
        >
          A computer in the cloud
          <br />
          for your AI agents
        </h1>
        <p
          className="mt-5 max-w-[34rem] text-[1rem] leading-[1.6] md:text-[1.0625rem]"
          style={{ color: c.subtle, fontFamily: fonts.sans }}
        >
          Run Claude, Codex, Cursor, and Hermes in one private hosted computer.
          Terminals, repos, previews, and workflows that keep going after your laptop closes.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          <SignedOut>
            <CtaButton href="https://app.matrix-os.com" phLocation="hero" phTarget="start_cloud_dev">
              Get started
            </CtaButton>
          </SignedOut>
          <SignedIn>
            <CtaButton href="https://app.matrix-os.com" phLocation="hero" phTarget="open_app">
              Open Matrix OS <ArrowRightIcon className="size-4" />
            </CtaButton>
          </SignedIn>
          <CtaButton href="/docs/users/quickstart" variant="outline">
            Read quickstart
          </CtaButton>
        </div>
      </div>

      <div
        className="mx-auto mt-12 max-w-[1200px] overflow-hidden rounded-2xl md:mt-16"
        style={{ backgroundColor: c.card, boxShadow: cardShadow }}
      >
        <video
          autoPlay
          loop
          muted
          playsInline
          aria-hidden="true"
          tabIndex={-1}
          preload="metadata"
          controls={false}
          src="/hero-loop.mp4"
          className="block aspect-[16/9] w-full object-cover object-center md:aspect-[21/10]"
        />
      </div>
    </SectionShell>
  );
}
