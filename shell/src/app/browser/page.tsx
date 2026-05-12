import { buildBrowserStandaloneAppUrl } from "@/lib/proxy-routes";

export default function BrowserStandaloneEmptyPage() {
  const src = buildBrowserStandaloneAppUrl(undefined);

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
