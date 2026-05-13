import { buildBrowserStandaloneAppUrl } from "@/lib/proxy-routes";

export default async function BrowserStandaloneEmptyPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const handoff = Array.isArray(params.handoff) ? params.handoff[0] : params.handoff;
  const src = buildBrowserStandaloneAppUrl(undefined, handoff);

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
