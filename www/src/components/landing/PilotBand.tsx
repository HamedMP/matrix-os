import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

export function PilotBand() {
  return (
    <SectionShell className="pt-5">
      <Reveal>
        <div
          className="flex flex-col gap-4 rounded-2xl px-7 py-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
        >
          <p className="max-w-2xl text-[0.9375rem] leading-[1.6]" style={{ color: "rgba(244,242,230,0.78)", fontFamily: fonts.sans }}>
            Running an enterprise evaluation, university pilot, or Hermes hosting rollout?
          </p>
          <Link
            href="/contact?audience=enterprise"
            className="inline-flex shrink-0 items-center gap-2 rounded-[0.625rem] px-4 py-3 text-[0.9375rem] font-medium leading-none transition-opacity hover:opacity-85"
            style={{ backgroundColor: "#F4F2E6", color: c.forestDeep }}
          >
            Plan a pilot <ArrowRightIcon className="size-4" />
          </Link>
        </div>
      </Reveal>
    </SectionShell>
  );
}
