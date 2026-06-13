import Image from "next/image";
import { palette as c, fonts } from "./theme";
import { SectionShell } from "./primitives";

const agentBrands = [
  { name: "Claude Code", logo: "/agents/claude-code.svg" },
  { name: "Codex", logo: "/agents/codex.svg" },
  { name: "Pi", logo: "/agents/pi.svg" },
  { name: "OpenCode", logo: "/agents/opencode.svg" },
  { name: "Cursor", logo: "/agents/cursor.svg" },
  { name: "Gemini CLI", logo: "/agents/gemini.svg" },
] as const;

export function AgentMarquee() {
  return (
    <SectionShell className="pt-14 md:pt-20">
      <p
        className="mb-7 text-center text-[0.8125rem] tracking-[0.02em]"
        style={{ color: c.subtle, fontFamily: fonts.sans }}
      >
        Works with the coding agents you already use
      </p>
      <div
        className="landing-marquee relative mx-auto max-w-[1000px] overflow-hidden"
        style={{
          maskImage: "linear-gradient(90deg, transparent, black 12%, black 88%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, black 12%, black 88%, transparent)",
        }}
      >
        <div className="landing-marquee-track items-center gap-14 pr-14">
          {[0, 1].map((copy) => (
            <div
              key={copy}
              aria-hidden={copy === 1}
              className="flex shrink-0 items-center gap-14"
            >
              {agentBrands.map((brand) => (
                <span
                  key={brand.name}
                  className="inline-flex shrink-0 items-center gap-2.5 text-[1rem] font-medium"
                  style={{ color: c.mutedFg, fontFamily: fonts.sans }}
                >
                  <Image
                    src={brand.logo}
                    alt=""
                    aria-hidden="true"
                    width={26}
                    height={26}
                    className="size-[26px] shrink-0 rounded-md object-contain opacity-80"
                    unoptimized
                  />
                  {brand.name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
