import { parseSharedAppOpenParams } from "@matrix-os/contracts";
import { notFound } from "next/navigation";
import { SharedAppHandoff } from "@/components/shared-app/SharedAppHandoff";

// Org link landing page (spec 2693 phase 4): hands off to the Matrix desktop app.
// It grants nothing; the platform checks organization membership when the app opens.
export default async function SharedAppOpenPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const link = parseSharedAppOpenParams((await params).scopeId, await searchParams);
  if (!link) notFound();
  return <SharedAppHandoff link={link} downloadUrl={process.env.NEXT_PUBLIC_MATRIX_DESKTOP_DOWNLOAD_URL || "https://matrix-os.com"} />;
}
