import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

const TALLY_FORM_ID = "2ED9lb";
const DISCORD_URL = "https://discord.gg/cSBBQWtPwV";
const TALLY_QUERY_KEYS = [
  "invite",
  "source",
  "userGroup",
  "utm_source",
  "utm_medium",
  "utm_campaign",
] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: "Matrix Early Access",
  description: "Request priority access to Matrix OS, the AI operating system for builders.",
  openGraph: {
    title: "Matrix Early Access",
    description: "Request priority access to Matrix OS, the AI operating system for builders.",
    url: "https://matrix-os.com/early-access",
    siteName: "Matrix OS",
    type: "website",
  },
};

export default async function EarlyAccessPage({ searchParams }: { searchParams: SearchParams }) {
  const tallyUrl = buildTallyEmbedUrl(await searchParams);

  return (
    <main className="min-h-screen bg-[var(--stone)] text-[var(--ink)]">
      <div className="mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-10 px-5 py-6 md:grid-cols-[0.82fr_1.18fr] md:px-8 md:py-10">
        <section className="flex flex-col justify-between gap-10 border-b border-[var(--pebble)] pb-8 md:border-b-0 md:border-r md:pb-0 md:pr-10">
          <div>
            <Link href="/" className="inline-flex items-center gap-3 text-sm font-medium tracking-[0.12em] uppercase">
              <Image src="/rabbit.svg" alt="Matrix OS" width={28} height={28} className="size-7 rounded-md" />
              Matrix OS
            </Link>

            <div className="mt-16 max-w-xl md:mt-24">
              <p className="text-sm font-medium uppercase tracking-[0.18em] text-[var(--moss)]">
                Early Access
              </p>
              <h1
                className="mt-5 text-4xl font-light leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                Tell me what you want Matrix to do first.
              </h1>
              <p className="mt-6 text-base leading-7 text-[var(--ink)]/65 sm:text-lg">
                I&apos;m opening early-access batches for builders who can try Matrix this week. Your answers help me prioritize engineers, technical founders, and concrete workflows.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-sm text-[var(--ink)]/65">
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center rounded-full border border-[var(--pebble)] px-4 py-2 text-[var(--ink)] transition-colors hover:border-[var(--forest)] hover:text-[var(--forest)]"
            >
              Join the Discord
            </a>
            <p>Priority goes to people with a clear first workflow and time to test soon.</p>
          </div>
        </section>

        <section className="flex h-[min(820px,calc(100vh-3rem))] min-h-[680px] flex-col overflow-hidden md:sticky md:top-10 md:h-[calc(100vh-5rem)] md:min-h-[760px]">
          {/* react-doctor-disable-next-line react-doctor/iframe-missing-sandbox -- trusted Tally embed needs both allow-scripts and allow-same-origin to run the hosted form */}
          <iframe
            src={tallyUrl}
            loading="lazy"
            width="100%"
            height="100%"
            frameBorder="0"
            marginHeight={0}
            marginWidth={0}
            scrolling="yes"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            referrerPolicy="strict-origin-when-cross-origin"
            title="Matrix Early Access Request"
            className="h-full w-full flex-1"
          />
        </section>
      </div>
    </main>
  );
}

function buildTallyEmbedUrl(searchParams: Awaited<SearchParams>) {
  const params = new URLSearchParams({
    alignLeft: "1",
    hideTitle: "1",
    transparentBackground: "1",
  });

  for (const key of TALLY_QUERY_KEYS) {
    const value = searchParams[key];
    const text = Array.isArray(value) ? value[0] : value;
    if (text) params.set(key, text);
  }

  return `https://tally.so/embed/${TALLY_FORM_ID}?${params.toString()}`;
}
