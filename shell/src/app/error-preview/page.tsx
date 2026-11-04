import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ErrorPreviewCrash from "../__error-preview/preview-crash";

export const metadata: Metadata = {
  title: "Error preview | Matrix OS",
  description: "Development-only page that throws to verify error tracking.",
};

export default async function ErrorPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const { kind } = await searchParams;
  return <ErrorPreviewCrash kind={kind === "stale-bundle" ? "stale-bundle" : "generic"} />;
}
