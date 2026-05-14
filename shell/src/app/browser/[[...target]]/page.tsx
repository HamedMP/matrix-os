import { buildBrowserStandaloneAppUrl } from "@/lib/proxy-routes";
import { BrowserStandaloneFrame } from "./BrowserStandaloneFrame";

interface BrowserStandalonePageProps {
  params: Promise<{ target?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BrowserStandalonePage({ params, searchParams }: BrowserStandalonePageProps) {
  const resolvedParams = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const targetQuery = new URLSearchParams();
  let hasTargetQuery = false;
  for (const [key, value] of Object.entries(resolvedSearch)) {
    if (key === "handoff" || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      targetQuery.append(key, entry);
      hasTargetQuery = true;
    }
  }
  const handoff = Array.isArray(resolvedSearch.handoff) ? resolvedSearch.handoff[0] : resolvedSearch.handoff;
  const src = buildBrowserStandaloneAppUrl(
    resolvedParams.target,
    handoff,
    hasTargetQuery ? targetQuery : undefined,
  );

  return (
    <main className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <BrowserStandaloneFrame src={src} />
    </main>
  );
}
