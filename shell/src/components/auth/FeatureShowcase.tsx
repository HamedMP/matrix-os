import { palette as c, fonts } from "@matrix-os/brand";
import { AuthAssetImage } from "@/components/auth/AuthAssetImage";

interface FeatureShowcaseProps {
  heading?: string;
  subheading?: string;
  variant?: "product" | "roster";
}

const AGENTS = [
  { name: "Claude", logo: "/agents/claude-code.svg" },
  { name: "Codex", logo: "/agents/codex.svg" },
  { name: "Cursor", logo: "/agents/cursor.svg" },
  { name: "Hermes", logo: "/rabbit.svg" },
] as const;

function Wordmark() {
  return (
    <div className="mb-8 flex items-center gap-3">
      <AuthAssetImage
        src="/rabbit.svg"
        alt="Matrix OS"
        width={34}
        height={34}
        className="size-[34px] rounded-lg border p-1.5"
        style={{ borderColor: c.border, backgroundColor: c.card }}
      />
      <span className="text-sm font-medium tracking-tight" style={{ color: c.forest }}>
        matrix-os
      </span>
    </div>
  );
}

export function FeatureShowcase({
  heading = "A computer in the cloud for your AI agents",
  subheading = "Run Claude, Codex, and Hermes as background agents that keep going after your laptop closes.",
  variant = "product",
}: FeatureShowcaseProps) {
  return (
    <div
      data-matrix-feature-showcase={variant}
      className="flex flex-col"
      style={{ fontFamily: fonts.sans }}
    >
      <Wordmark />

      <h1
        className="text-balance tracking-[-0.01em]"
        style={{
          fontFamily: fonts.display,
          fontWeight: 400,
          color: c.deep,
          lineHeight: 1.02,
          fontSize:
            variant === "roster"
              ? "clamp(2.8rem,5vw,4rem)"
              : "clamp(2.4rem,4.2vw,3.2rem)",
          maxWidth: "13ch",
        }}
      >
        {heading}
      </h1>
      <p
        className="mt-5 max-w-[42ch] text-[15px] leading-[1.6] md:text-base"
        style={{ color: c.mutedFg }}
      >
        {subheading}
      </p>

      {variant === "product" ? (
        <div
          className="mt-10 hidden max-w-[440px] overflow-hidden rounded-2xl border lg:block"
          style={{
            borderColor: c.border,
            backgroundColor: c.card,
            boxShadow: "0 24px 60px rgba(50,53,46,0.10)",
          }}
        >
          <div
            className="flex items-center gap-1.5 border-b px-3 py-2"
            style={{ borderColor: c.border, backgroundColor: "#F1EFE7" }}
          >
            <span className="size-[7px] rounded-full" style={{ backgroundColor: c.border }} />
            <span className="size-[7px] rounded-full" style={{ backgroundColor: c.border }} />
            <span className="size-[7px] rounded-full" style={{ backgroundColor: c.border }} />
            <span
              className="ml-2 text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)", color: c.subtle }}
            >
              workspace
            </span>
          </div>
          <div className="grid grid-cols-2 gap-px" style={{ backgroundColor: c.border }}>
            <div
              className="space-y-1.5 p-3.5"
              style={{
                backgroundColor: c.forestDeep,
                minHeight: 116,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 11,
                lineHeight: 1.7,
              }}
            >
              <p style={{ color: "#9FB39A" }}>$ claude build tracker</p>
              <p style={{ color: c.cream }}>› writing ~/apps/app.tsx</p>
              <p style={{ color: "#C0DD97" }}>✓ done in 4.2s</p>
            </div>
            <div className="p-3.5" style={{ backgroundColor: c.card }}>
              <p
                className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: c.subtle }}
              >
                Agents
              </p>
              <div className="mt-2.5 flex flex-col gap-2 text-[12px]" style={{ color: c.deep }}>
                <span className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: "#639922" }} />
                  Claude · running
                </span>
                <span className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: "#639922" }} />
                  Codex · PR opened
                </span>
                <span className="flex items-center gap-2" style={{ color: c.subtle }}>
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: c.border }} />
                  Hermes · idle
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-10 hidden border-t pt-6 lg:block" style={{ borderColor: c.border }}>
          <p
            className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: c.subtle }}
          >
            Runs your agents
          </p>
          <div className="flex flex-wrap gap-2">
            {AGENTS.map((agent) => (
              <span
                key={agent.name}
                className="inline-flex items-center gap-2 rounded-full border py-1.5 pl-2 pr-3 text-[13px]"
                style={{ color: c.deep, borderColor: c.border, backgroundColor: c.card }}
              >
                <AuthAssetImage
                  src={agent.logo}
                  alt=""
                  width={18}
                  height={18}
                  className="size-[18px] rounded object-contain"
                />
                {agent.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        className="mx-auto mt-7 grid w-full max-w-md border-y lg:hidden"
        style={{ borderColor: c.border }}
      >
        {AGENTS.map((agent, index) => (
          <div
            key={agent.name}
            className="flex items-center gap-3 py-3 text-sm font-medium"
            style={{
              color: c.forest,
              ...(index > 0 ? { borderTop: `1px solid ${c.border}` } : {}),
            }}
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
              style={{ borderColor: c.border, backgroundColor: c.card }}
            >
              <AuthAssetImage
                src={agent.logo}
                alt=""
                width={20}
                height={20}
                className="size-5 rounded object-contain"
              />
            </span>
            {agent.name}
          </div>
        ))}
      </div>
    </div>
  );
}
