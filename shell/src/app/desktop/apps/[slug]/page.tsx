"use client";

import { useParams } from "next/navigation";
import { AppViewer } from "@/components/AppViewer";
import { DesktopStandaloneFrame } from "@/components/desktop/DesktopStandaloneFrame";

function readSlug(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default function DesktopAppPage() {
  const params = useParams<{ slug?: string | string[] }>();
  const slug = readSlug(params.slug);

  return (
    <DesktopStandaloneFrame>
      {slug ? <AppViewer path={`apps/${slug}/index.html`} /> : null}
    </DesktopStandaloneFrame>
  );
}
