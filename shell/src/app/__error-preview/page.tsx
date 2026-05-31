import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ErrorPreviewCrash from "./preview-crash";

export const metadata: Metadata = {
  title: "Error preview | Matrix OS",
  description: "Development-only page that throws to verify error tracking.",
};

export default function ErrorPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <ErrorPreviewCrash />;
}
