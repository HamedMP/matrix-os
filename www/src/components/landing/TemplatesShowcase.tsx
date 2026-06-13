import Image from "next/image";
import Link from "next/link";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  BugIcon,
  FileTextIcon,
  LayersIcon,
  ListChecksIcon,
  MessageCircleIcon,
  PackageIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { palette as c, cardShadow, fonts } from "./theme";
import { SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

const templateTasks = [
  { Icon: BugIcon, label: "Fix bugs from Linear" },
  { Icon: ShieldCheckIcon, label: "Verify merged changes" },
  { Icon: ListChecksIcon, label: "Summarize CI failures" },
  { Icon: AlertCircleIcon, label: "Triage Sentry errors" },
  { Icon: PackageIcon, label: "Patch vulnerable deps" },
  { Icon: FileTextIcon, label: "Draft release notes" },
  { Icon: LayersIcon, label: "Pick up backlog work" },
  { Icon: MessageCircleIcon, label: "Turn Discord feedback into Linear tasks" },
] as const;

export function TemplatesShowcase() {
  return (
    <SectionShell className="pt-16 md:pt-28">
      <Reveal>
        <div className="relative overflow-hidden rounded-2xl" style={{ boxShadow: cardShadow }}>
          <Image
            src="/images/app-screenshot.jpg"
            alt=""
            aria-hidden="true"
            fill
            sizes="(max-width: 768px) 100vw, 1320px"
            className="object-cover"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{ background: "linear-gradient(115deg, rgba(38,46,34,0.94) 0%, rgba(38,46,34,0.78) 45%, rgba(38,46,34,0.45) 100%)" }}
          />

          <div className="relative grid gap-10 p-7 md:grid-cols-[1fr_minmax(0,26rem)] md:gap-16 md:p-12 lg:p-16">
            <h2
              className="max-w-[24rem] text-[1.75rem] leading-[1.2] font-medium tracking-[-0.01em] md:text-[2.25rem]"
              style={{ color: "#F8F7EE", fontFamily: fonts.sans }}
            >
              What you can hand to your agents.{" "}
              <span style={{ color: "rgba(248,247,238,0.55)", fontWeight: 500 }}>
                Coding tasks, review chores, incidents, and business workflows running on your Matrix computer.
              </span>
            </h2>

            <div className="rounded-xl px-6 py-3 md:px-7" style={{ backgroundColor: "rgba(252,252,248,0.97)" }}>
              <ul>
                {templateTasks.map((task, index) => (
                  <li
                    key={task.label}
                    className={`flex items-center gap-3.5 py-3.5 md:py-4 ${index < templateTasks.length - 1 ? "border-b" : ""}`}
                    style={{ borderColor: "rgba(67,78,63,0.12)" }}
                  >
                    <task.Icon className="size-4 shrink-0" style={{ color: c.forest }} aria-hidden="true" />
                    <span className="text-[0.9375rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                      {task.label}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href="/use-cases"
                className="group inline-flex items-center gap-1.5 py-4 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                style={{ color: c.forest }}
              >
                Explore all use cases
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </SectionShell>
  );
}
