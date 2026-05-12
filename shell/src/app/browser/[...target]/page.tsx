import { buildBrowserStandaloneAppUrl } from "@/lib/proxy-routes";

interface BrowserStandalonePageProps {
  params: Promise<{ target?: string[] }>;
  searchParams?: Promise<{ handoff?: string }>;
}

export default async function BrowserStandalonePage({ params, searchParams }: BrowserStandalonePageProps) {
  const resolvedParams = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const src = buildBrowserStandaloneAppUrl(resolvedParams.target, resolvedSearch.handoff);

  return (
    <main className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <iframe
        title="Matrix Browser"
        src={src}
        className="h-full w-full border-0"
        allow="autoplay; fullscreen"
      />
    </main>
  );
}
