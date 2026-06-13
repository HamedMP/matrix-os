import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { palette as c, fonts } from "./theme";
import { CtaButton, SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

export function FinalCtaSection() {
  return (
    <SectionShell className="pt-20 pb-8 md:pt-32 md:pb-12">
      <Reveal>
        <div className="mx-auto flex max-w-[44rem] flex-col items-center text-center">
          <h2
            className="text-[2.25rem] leading-[1.08] md:text-[3.25rem]"
            style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
          >
            Move your agents off your laptop
          </h2>
          <p className="mt-4 max-w-[30rem] text-[1rem] leading-[1.6]" style={{ color: c.subtle, fontFamily: fonts.sans }}>
            Start with one cloud workspace. Add agents, tools, workflows, and teammates as the work grows.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            <SignedOut>
              <CtaButton href="https://app.matrix-os.com" large phLocation="final_cta" phTarget="start_cloud_dev">
                Get started
              </CtaButton>
            </SignedOut>
            <SignedIn>
              <CtaButton href="https://app.matrix-os.com" large phLocation="final_cta" phTarget="open_app">
                Open Matrix OS <ArrowRightIcon className="size-4" />
              </CtaButton>
            </SignedIn>
            <CtaButton href="/contact" variant="outline" large>
              Request a demo
            </CtaButton>
          </div>
          <p className="mt-6 text-[0.8125rem] leading-relaxed" style={{ color: c.subtle }}>
            By using Matrix OS, you agree to the{" "}
            <Link href="/terms" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
              Terms
            </Link>{" "}
            and acknowledge the{" "}
            <Link href="/privacy" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </Reveal>
    </SectionShell>
  );
}
