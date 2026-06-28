import Image from "next/image";
import { ArrowRightIcon } from "lucide-react";
import { palette as c, cardShadow, fonts } from "./theme";
import { CtaButton, SectionShell } from "./primitives";
import { CopyPromptButton } from "./CopyPromptButton";
import { COPYABLE_AGENT_SETUP_PROMPT } from "./content";
import { SIGN_UP_HREF } from "./links";

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
          className="mt-5 max-w-[36rem] text-[1rem] leading-[1.6] md:text-[1.0625rem]"
          style={{ color: c.subtle, fontFamily: fonts.sans }}
        >
          Run Claude, Codex, Cursor, and Hermes as background agents on one private hosted
          computer. Terminals, repos, previews, and workflows that keep going after your laptop closes.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          <CtaButton href={SIGN_UP_HREF} phLocation="hero" phTarget="start_cloud_dev">
            Get started <ArrowRightIcon className="size-4" />
          </CtaButton>
          <CopyPromptButton text={COPYABLE_AGENT_SETUP_PROMPT} />
        </div>
        <p className="mt-4 text-[0.8125rem]" style={{ color: c.subtle, fontFamily: fonts.sans }}>
          Free to sign up. Or copy the prompt into Claude Code, Codex, or Cursor and your agent
          sets Matrix up for you.
        </p>
      </div>

      <div
        className="mx-auto mt-12 max-w-[1200px] overflow-hidden rounded-2xl md:mt-16"
        style={{ backgroundColor: c.card, boxShadow: cardShadow }}
      >
        <Image
          src="/images/app-screenshot.jpg"
          alt="The Matrix OS workspace with terminals, apps, and agent sessions"
          width={1920}
          height={1080}
          priority
          className="block h-auto w-full"
        />
      </div>
    </SectionShell>
  );
}
