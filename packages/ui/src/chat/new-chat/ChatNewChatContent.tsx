import { Bug, CircleCheck, Hammer, Search } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

const STARTERS = [
  { label: "Explore and understand code", icon: Search, tone: "var(--success)" },
  { label: "Build a new feature, app, or tool", icon: Hammer, tone: "var(--info)" },
  { label: "Review code and suggest changes", icon: CircleCheck, tone: "var(--success)" },
  { label: "Fix issues and failures", icon: Bug, tone: "var(--warning)" },
] as const;

/** The four new-Chat starter prompts shared by Web and Electron Desktop. */
export function ChatStarterCards({
  layout = "responsive",
  density = "regular",
  onSelect,
}: {
  layout?: "responsive" | "two-by-two";
  density?: "regular" | "compact";
  onSelect: (prompt: string) => void;
}) {
  const columns = density === "compact"
    ? "grid-cols-1"
    : `grid-cols-2 ${layout === "responsive" ? "sm:grid-cols-4" : "@min-[34rem]/chat-home:grid-cols-4"}`;
  return (
    <div className={`grid gap-3 ${columns}`} data-slot="chat-starter-cards">
      {STARTERS.map(({ label, icon, tone }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          onClick={() => onSelect(label)}
          className={`flex flex-col items-start gap-3 rounded-xl border text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))] ${density === "compact" ? "min-h-20 p-3" : "min-h-[120px] p-[15px]"}`}
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px]" style={{ background: `color-mix(in srgb, ${tone} 12%, var(--bg-surface))`, color: tone }}>
            <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} aria-hidden />
          </span>
          <span className="text-[14px] font-medium leading-[18px]" style={{ color: "var(--text-primary)" }}>
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * New-Chat screen shared by Web and Electron Desktop: the welcome and starter
 * cards scroll above, and the composer stays in the 808px column below. Hosts
 * pass their own logo and onboarding wrapper.
 */
export function ChatNewChatContent({ logo, layout, composer, inProject = false, wrapHero = (children) => children, onSelect }: {
  logo: ReactNode;
  /** A Project's new-Chat draft; hosts and tests find its scroll area by this slot. */
  inProject?: boolean;
  layout: "narrow" | "wide";
  composer: ReactNode;
  wrapHero?: (children: ReactNode) => ReactNode;
  onSelect: (prompt: string) => void;
}) {
  return (
    // The root scrolls (not the composer column) so a composer taller than a short phone
    // screen keeps Send reachable while the slash and mention menus above the card stay unclipped.
    <div data-slot="chat-new-chat-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div
        data-slot={inProject ? "chat-project-draft-scroll" : "chat-starter-scroll"}
        className={`flex min-h-0 flex-1 items-start justify-center overflow-y-auto ${layout === "narrow" ? "px-3 py-3" : "px-5 pt-8 pb-[53px]"}`}
        style={{ scrollbarGutter: "stable both-edges" }}
      >
        <div data-slot="chat-starter-stack" className="@container/chat-home my-auto w-full max-w-[716px]">
          {wrapHero(<>
            <div className="mb-4 grid justify-items-center gap-4 text-center">
              <span className="flex size-11 items-center justify-center rounded-full" style={{ background: "var(--text-primary)", color: "var(--bg-surface)" }}>
                {logo}
              </span>
              <h1 className="text-[26px] font-medium leading-[31px]" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
                What should we build today?
              </h1>
              <p className="text-[15px] leading-[22px]" style={{ color: "var(--text-tertiary)" }}>I’m Matrix. What should I start on?</p>
            </div>
            <ChatStarterCards layout="two-by-two" density={layout === "narrow" ? "compact" : "regular"} onSelect={onSelect} />
          </>)}
        </div>
      </div>
      <ChatComposerColumn layout={layout}>{composer}</ChatComposerColumn>
    </div>
  );
}

/** The 808px column Electron Desktop and Web Chat put the composer in. */
export function ChatComposerColumn({ layout, children }: { layout: "narrow" | "wide"; children: ReactNode }) {
  return (
    <div className={`mx-auto w-full max-w-[808px] shrink-0 ${layout === "narrow" ? "px-3 pb-3" : "px-6 pb-5"}`}>
      {children}
    </div>
  );
}
