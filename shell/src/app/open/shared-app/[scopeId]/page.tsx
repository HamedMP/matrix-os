import { parseSharedAppOpenParams } from "@matrix-os/contracts";
import { notFound } from "next/navigation";
import { SharedAppHandoff } from "@/components/shared-app/SharedAppHandoff";
import { SharedAppLaunchScript } from "@/components/shared-app/shared-app-launch-script";

// Org link landing page (spec 2693 phase 4): hands off to the Matrix desktop app.
// It grants nothing; the platform checks organization membership when the app opens.
export default async function SharedAppOpenPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const link = parseSharedAppOpenParams((await params).scopeId, await searchParams);
  if (!link) notFound();
  // Server-rendered launch script: the desktop app opens as soon as the HTML is
  // parsed, not after the page's JavaScript downloads and hydrates.
  return <>
    <SharedAppLaunchScript link={link} />
    <SharedAppHandoff link={link} downloadUrl={process.env.NEXT_PUBLIC_MATRIX_DESKTOP_DOWNLOAD_URL || "https://matrix-os.com"} />
  </>;
}
