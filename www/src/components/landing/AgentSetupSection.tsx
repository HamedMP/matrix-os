import Image from "next/image";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { CopyPromptButton } from "./CopyPromptButton";
import { COPYABLE_AGENT_SETUP_PROMPT } from "./content";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const agentBrands = [
  { name: "Claude Code", logo: "/agents/claude-code.svg" },
  { name: "Codex", logo: "/agents/codex.svg" },
  { name: "Pi", logo: "/agents/pi.svg" },
  { name: "OpenCode", logo: "/agents/opencode.svg" },
  { name: "Cursor", logo: "/agents/cursor.svg" },
  { name: "Gemini CLI", logo: "/agents/gemini.svg" },
] as const;

export function AgentSetupSection() {
  return (
    <SectionShell id="developers" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="grid md:grid-cols-[0.95fr_1.05fr]">
            <div className="flex flex-col px-7 py-9 md:border-r md:px-12 md:py-12" style={{ borderColor: c.border }}>
              <SectionTitle
                title="Paste one message."
                continuation="Your agent moves itself into Matrix."
              />
              <p className="mt-5 max-w-[26rem] text-[0.9375rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                Matrix publishes a setup skill at <code className="rounded px-1.5 py-0.5 text-[0.8125rem]" style={{ backgroundColor: "rgba(67,78,63,0.07)" }}>matrix-os.com/skills.md</code>.
                Give it to your coding agent so it can install the CLI, guide login, attach to your
                cloud shell, and start work.
              </p>
              <div className="mt-7 flex flex-wrap gap-2.5" aria-label="Supported coding agents">
                {agentBrands.map((brand) => (
                  <span
                    key={brand.name}
                    className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[0.8125rem] font-medium"
                    style={{ border: `1px solid ${c.border}`, color: c.deep, fontFamily: fonts.sans }}
                  >
                    <Image
                      src={brand.logo}
                      alt=""
                      aria-hidden="true"
                      width={18}
                      height={18}
                      className="size-[18px] shrink-0 rounded object-contain"
                      unoptimized
                    />
                    {brand.name}
                  </span>
                ))}
              </div>
              <div className="mt-auto flex flex-wrap gap-4 pt-8">
                {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- /skills.md is a static public file, not a Next route; Link would prefetch/client-navigate raw markdown */}
                <a
                  href="/skills.md"
                  className="group inline-flex items-center gap-1.5 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                  style={{ color: c.forest }}
                >
                  Open skills.md
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                </a>
                <Link
                  href="/docs/users/quickstart"
                  className="group inline-flex items-center gap-1.5 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                  style={{ color: c.forest }}
                >
                  Quickstart
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>

            <div className="px-7 py-9 md:px-12 md:py-12">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>Copy for your agent</p>
                <CopyPromptButton text={COPYABLE_AGENT_SETUP_PROMPT} label="Copy" compact />
              </div>
              <pre
                className="max-h-[340px] overflow-auto rounded-xl p-5 text-left text-[0.8125rem] leading-[1.7] whitespace-pre-wrap"
                style={{ backgroundColor: "rgba(67,78,63,0.05)", color: c.deep, border: `1px solid ${c.border}` }}
              >
                <code>{COPYABLE_AGENT_SETUP_PROMPT}</code>
              </pre>
            </div>
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
