import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon, BotIcon, BriefcaseBusinessIcon, Building2Icon, GraduationCapIcon, ShieldCheckIcon } from "lucide-react";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const c = {
  forest: "#434E3F",
  deep: "#32352E",
  ember: "#D06F25",
  pageBg: "#E2E2CF",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

export const metadata: Metadata = {
  title: "Contact Matrix OS",
  description:
    "Talk to Matrix OS about cloud-native development, professional AI assistants, Hermes hosting, enterprise pilots, and universities.",
  openGraph: {
    title: "Contact Matrix OS",
    description:
      "Talk to Matrix OS about cloud-native development, professional AI assistants, Hermes hosting, enterprise pilots, and universities.",
    url: "https://matrix-os.com/contact",
    siteName: "Matrix OS",
    type: "website",
  },
};

const contactCards = [
  {
    Icon: Building2Icon,
    title: "Teams and startups",
    desc: "Pilot always-on cloud dev computers for autonomous coding, PR review, previews, and workflow automation.",
  },
  {
    Icon: ShieldCheckIcon,
    title: "Enterprise AI labs",
    desc: "Let employees try modern AI coding tools in isolated cloud environments when local installs are restricted.",
  },
  {
    Icon: GraduationCapIcon,
    title: "Universities",
    desc: "Run repeatable software labs, workshops, hackathons, and research environments with less local setup drift.",
  },
  {
    Icon: BotIcon,
    title: "Hermes hosting",
    desc: "Give the Matrix-native agent an always-on home for connected tools, scheduled workflows, and approvals.",
  },
  {
    Icon: BriefcaseBusinessIcon,
    title: "Professionals",
    desc: "Host an always-on assistant for research, planning, follow-ups, docs, dashboards, and connected-tool workflows.",
  },
] as const;

export default async function ContactPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const audience = getParam(params.audience);
  const submitted = getParam(params.submitted) === "1";

  return (
    <main
      className="min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif" }}
    >
      <ContactNav />

      <div className="mx-auto grid min-h-screen w-full max-w-[1100px] grid-cols-1 gap-10 px-6 pt-32 pb-14 md:grid-cols-[0.86fr_1.14fr] md:px-8 md:pt-36 md:pb-20">
        <section className="flex flex-col justify-between gap-10 border-b pb-8 md:border-b-0 md:border-r md:pb-0 md:pr-10" style={{ borderColor: c.border }}>
          <div>
            <div className="max-w-xl">
              <Link
                href="/"
                className="mb-8 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] transition-opacity hover:opacity-70"
                style={{ color: c.subtle }}
              >
                <ArrowLeftIcon className="size-3.5" />
                Back home
              </Link>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
                Contact
              </p>
              <h1 className="mt-5 text-[clamp(2.25rem,5.5vw,4.1rem)] font-normal leading-[1.05]" style={{ color: c.forest }}>
                Bring Matrix to your work.
              </h1>
              <p className="mt-6 text-[16px] leading-[1.85]" style={{ color: c.mutedFg }}>
                Tell us what you want to evaluate: autonomous coding agents, Hermes hosting, professional assistant workflows, secure AI experimentation, university labs, or a broader Matrix cloud-computer rollout.
              </p>
            </div>
          </div>

          <div className="grid gap-3">
            {contactCards.map((item) => (
              <article key={item.title} className="grid grid-cols-[2.25rem_1fr] gap-3 rounded-[16px] p-4" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
                <span className="grid size-9 place-items-center rounded-full" style={{ backgroundColor: "rgba(208,111,37,0.1)", color: c.ember }}>
                  <item.Icon className="size-4" />
                </span>
                <div>
                  <h2 className="text-[14px] font-semibold" style={{ color: c.forest }}>{item.title}</h2>
                  <p className="mt-1 text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.desc}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="flex min-h-[700px] flex-col overflow-hidden rounded-[22px] md:sticky md:top-24 md:min-h-[780px]" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
          <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: c.border }}>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>Contact Matrix</p>
              <p className="mt-1 text-[13px]" style={{ color: c.mutedFg }}>We will route the request to the right pilot path.</p>
            </div>
            <ArrowRightIcon className="hidden size-4 sm:block" style={{ color: c.forest }} />
          </div>
          <form action={submitContactRequest} className="grid flex-1 content-start gap-5 p-5 sm:p-7">
            <input type="hidden" name="source" value="contact" />
            <input type="hidden" name="audience" value={audience ?? ""} />

            {submitted ? (
              <div className="rounded-[16px] p-4 text-[13px] leading-[1.7]" style={{ backgroundColor: "rgba(67,78,63,0.08)", border: `1px solid ${c.border}`, color: c.forest }}>
                Thanks. Your request was recorded. We will follow up through the email you provided.
              </div>
            ) : null}

            <div className="grid gap-2">
              <label htmlFor="name" className="text-[13px] font-medium" style={{ color: c.forest }}>
                Name
              </label>
              <input
                id="name"
                name="name"
                required
                autoComplete="name"
                className="min-h-12 rounded-[16px] px-4 text-[14px] outline-none transition-colors"
                style={{ backgroundColor: "rgba(226,226,207,0.58)", border: `1px solid ${c.border}`, color: c.deep }}
                placeholder="Your name"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="email" className="text-[13px] font-medium" style={{ color: c.forest }}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="min-h-12 rounded-[16px] px-4 text-[14px] outline-none transition-colors"
                style={{ backgroundColor: "rgba(226,226,207,0.58)", border: `1px solid ${c.border}`, color: c.deep }}
                placeholder="you@company.com"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="organization" className="text-[13px] font-medium" style={{ color: c.forest }}>
                Company or university <span className="font-normal" style={{ color: c.subtle }}>(optional)</span>
              </label>
              <input
                id="organization"
                name="organization"
                autoComplete="organization"
                className="min-h-12 rounded-[16px] px-4 text-[14px] outline-none transition-colors"
                style={{ backgroundColor: "rgba(226,226,207,0.58)", border: `1px solid ${c.border}`, color: c.deep }}
                placeholder="Organization name"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="useCase" className="text-[13px] font-medium" style={{ color: c.forest }}>
                What are you evaluating?
              </label>
              <select
                id="useCase"
                name="useCase"
                defaultValue={normalizeAudience(audience)}
                className="min-h-12 rounded-[16px] px-4 text-[14px] outline-none transition-colors"
                style={{ backgroundColor: "rgba(226,226,207,0.58)", border: `1px solid ${c.border}`, color: c.deep }}
              >
                <option value="developer">Developer cloud workspace</option>
                <option value="professional-assistant">Professional assistant</option>
                <option value="hermes-hosting">Easy Hermes hosting</option>
                <option value="enterprise">Enterprise AI experimentation</option>
                <option value="university">University or lab pilot</option>
                <option value="team">Team rollout</option>
                <option value="cloud-computer">Broader cloud computer use case</option>
              </select>
            </div>

            <div className="grid gap-2">
              <label htmlFor="message" className="text-[13px] font-medium" style={{ color: c.forest }}>
                First workflow or constraint
              </label>
              <textarea
                id="message"
                name="message"
                required
                rows={6}
                className="resize-none rounded-[16px] px-4 py-3 text-[14px] leading-6 outline-none transition-colors"
                style={{ backgroundColor: "rgba(226,226,207,0.58)", border: `1px solid ${c.border}`, color: c.deep }}
                placeholder="Example: I want Hermes to handle weekly research, inbox triage, and follow-ups in an always-on workspace."
              />
            </div>

            <button
              type="submit"
              className="inline-flex min-h-12 w-fit items-center justify-center gap-2 rounded-full px-6 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
              style={{ backgroundColor: c.forest, color: c.pageBg }}
            >
              Get pilot guidance <ArrowRightIcon className="size-3.5" />
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function ContactNav() {
  return (
    <div className="fixed left-1/2 top-5 z-50 w-fit max-w-[calc(100vw-1rem)] -translate-x-1/2">
      <div
        className="flex min-h-12 items-center gap-2 rounded-full px-3 shadow-[0_12px_32px_rgba(50,53,46,0.08)] backdrop-blur-md"
        style={{ backgroundColor: "rgba(250,250,245,0.86)", border: `1px solid ${c.border}` }}
      >
        <Link href="/" className="inline-flex min-h-8 items-center gap-2 rounded-full px-2.5 text-[12px] font-medium transition-opacity hover:opacity-75" style={{ color: c.forest }}>
          <Image src="/rabbit.svg" alt="Matrix OS" width={20} height={26} className="h-6 w-auto" />
          <span>Matrix OS</span>
        </Link>
        <Link
          href="/solutions"
          className="inline-flex min-h-8 items-center rounded-full px-3 text-[10px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
          style={{ backgroundColor: c.forest, color: c.pageBg }}
        >
          Solutions
        </Link>
      </div>
    </div>
  );
}

async function submitContactRequest(formData: FormData) {
  "use server";

  const payload = {
    audience: truncate(formData.get("audience"), 80),
    email: truncate(formData.get("email"), 160),
    message: truncate(formData.get("message"), 1200),
    name: truncate(formData.get("name"), 120),
    organization: truncate(formData.get("organization"), 160),
    source: truncate(formData.get("source"), 80),
    useCase: truncate(formData.get("useCase"), 120),
  };

  after(() => {
    logContactRequest(payload);
  });

  redirect("/contact?submitted=1");
}

function logContactRequest(payload: Record<string, string>) {
  // Server logs are the temporary contact intake until a CRM/email provider is wired.
  console.log("[contact-request]", JSON.stringify(payload));
}

function getParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeAudience(audience: string | undefined) {
  if (audience === "enterprise" || audience === "university") return audience;
  if (audience === "team") return "team";
  if (audience === "cloud-computer") return "cloud-computer";
  if (audience === "professional-assistant") return "professional-assistant";
  if (audience === "hermes-hosting") return "hermes-hosting";
  return "developer";
}

function truncate(value: FormDataEntryValue | null, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}
