import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Releases | Matrix OS",
  description: "Matrix OS host-bundle release notes, upgrade channels, and VPS upgrade commands.",
};

type Release = {
  version?: string;
  channel?: string | null;
  gitCommit?: string;
  gitRef?: string | null;
  buildTime?: string;
  bundleSha256?: string;
  sha256?: string;
  size?: number;
  severity?: string;
  updateType?: string;
  changelog?: string | null;
  createdAt?: string;
};

async function fetchReleases(): Promise<{ releases: Release[]; error?: string }> {
  const platformUrl = process.env.PLATFORM_PUBLIC_URL ?? "https://app.matrix-os.com";

  try {
    const url = new URL("/system-bundles/releases", platformUrl);
    url.searchParams.set("channel", "stable");
    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { releases: [], error: "Release metadata is temporarily unavailable." };
    }
    const data = await response.json() as { releases?: Release[] };
    return { releases: data.releases ?? [] };
  } catch (error: unknown) {
    console.error("Failed to fetch Matrix OS release metadata", error);
    return { releases: [], error: "Release metadata is temporarily unavailable." };
  }
}

function formatDate(value?: string): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(value?: number): string | null {
  if (typeof value !== "number") return null;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function releaseKey(release: Release, index: number): string {
  return release.version ?? release.gitCommit ?? `${release.channel ?? "stable"}-${release.createdAt ?? "unknown"}-${index}`;
}

export default async function ReleasesPage() {
  const { releases, error } = await fetchReleases();
  const [latest, ...previous] = releases;

  return (
    <main className="min-h-screen bg-[#E2E2CF] text-[#32352E]">
      <nav className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <Link href="/" className="text-sm font-semibold tracking-[0.18em] uppercase">Matrix OS</Link>
        <div className="flex items-center gap-5 text-xs uppercase tracking-[0.16em] text-[#5C5A4F]">
          <Link href="/docs">Docs</Link>
          <a href="https://github.com/HamedMP/matrix-os">GitHub</a>
          <a href="https://app.matrix-os.com">Open app</a>
        </div>
      </nav>

      <section className="mx-auto max-w-5xl px-6 pb-16 pt-10">
        <p className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-[#D06F25]">
          Host-bundle releases
        </p>
        <h1 className="max-w-3xl text-4xl font-light leading-tight sm:text-5xl">
          Stable Matrix OS runtime updates
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[#5C5A4F]">
          These releases update the VPS-native Matrix OS runtime: shell, gateway,
          bundled apps, update tooling, and system services. Owner data under the
          Matrix home is preserved during upgrades.
        </p>
      </section>

      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-16 lg:grid-cols-[1.4fr_0.9fr]">
        <div className="rounded-lg border border-[#D6D3C8] bg-[#ECECDA] p-6">
          <p className="mb-2 text-xs uppercase tracking-[0.16em] text-[#5C5A4F]">Latest stable</p>
          {error ? (
            <p className="text-sm text-[#5C5A4F]">{error}</p>
          ) : latest ? (
            <ReleaseSummary release={latest} prominent />
          ) : (
            <p className="text-sm text-[#5C5A4F]">No stable releases have been published yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-[#D6D3C8] bg-[#ECECDA] p-6">
          <p className="mb-4 text-xs uppercase tracking-[0.16em] text-[#5C5A4F]">Upgrade</p>
          <div className="space-y-4 text-sm leading-6 text-[#5C5A4F]">
            <p>From a customer VPS terminal:</p>
            <pre className="overflow-x-auto rounded-md bg-[#32352E] p-3 text-xs text-[#E2E2CF]">
              matrix-update stable
            </pre>
            <p>From the web shell, open Settings, then System, then Updates.</p>
            <p>Operators should promote and deploy through the platform release endpoints.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        <h2 className="mb-5 text-xl font-medium">Previous stable releases</h2>
        <div className="divide-y divide-[#D6D3C8] rounded-lg border border-[#D6D3C8] bg-[#ECECDA]">
          {previous.length === 0 ? (
            <p className="p-6 text-sm text-[#5C5A4F]">No earlier stable releases are listed.</p>
          ) : previous.slice(0, 12).map((release, index) => (
            <div key={releaseKey(release, index)} className="p-5">
              <ReleaseSummary release={release} />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ReleaseSummary({ release, prominent = false }: { release: Release; prominent?: boolean }) {
  const checksum = release.bundleSha256 ?? release.sha256;
  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className={prominent ? "font-mono text-2xl" : "font-mono text-base"}>
          {release.version ?? "unknown"}
        </h2>
        <span className="rounded-full border border-[#D6D3C8] px-2.5 py-1 text-xs uppercase tracking-[0.12em] text-[#5C5A4F]">
          {release.channel ?? "stable"}
        </span>
        {release.severity && release.severity !== "normal" && (
          <span className="rounded-full bg-[#D06F25] px-2.5 py-1 text-xs uppercase tracking-[0.12em] text-white">
            {release.severity}
          </span>
        )}
      </div>
      {release.changelog && (
        <p className={prominent ? "text-base leading-7 text-[#32352E]" : "text-sm leading-6 text-[#5C5A4F]"}>
          {release.changelog}
        </p>
      )}
      <dl className="grid gap-2 text-xs text-[#5C5A4F] sm:grid-cols-2">
        <Meta label="Published" value={formatDate(release.createdAt ?? release.buildTime)} />
        <Meta label="Commit" value={release.gitCommit?.slice(0, 12)} />
        <Meta label="Ref" value={release.gitRef ?? undefined} />
        <Meta label="Bundle" value={formatSize(release.size) ?? undefined} />
        <Meta label="Checksum" value={checksum?.slice(0, 16)} />
        <Meta label="Update type" value={release.updateType} />
      </dl>
    </article>
  );
}

function Meta({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <dt>{label}</dt>
      <dd className="truncate font-mono text-[#32352E]">{value}</dd>
    </div>
  );
}
