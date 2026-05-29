import { notFound } from "next/navigation";
import ErrorPreviewCrash from "./preview-crash";

export default function ErrorPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <ErrorPreviewCrash />;
}
