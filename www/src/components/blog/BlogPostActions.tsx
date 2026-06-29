"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CheckIcon, Share2Icon } from "lucide-react";
import { palette as c } from "@/components/landing/theme";

export function BlogPostActions({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function sharePost() {
    const shareData = {
      title: document.title,
      url,
    };

    setFailed(false);

    try {
      if (navigator.share && (navigator.canShare?.(shareData) ?? true)) {
        await navigator.share(shareData);
        return;
      }

      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.warn("[blog-share]", error);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2200);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={sharePost}
        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-white"
        style={{ borderColor: c.border, color: c.deep }}
      >
        {copied ? <CheckIcon className="size-4" strokeWidth={1.75} /> : <Share2Icon className="size-4" strokeWidth={1.75} />}
        {failed ? "Share failed" : copied ? "Copied" : "Share Post"}
      </button>
      <Link
        href="/blog"
        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-white"
        style={{ borderColor: c.border, color: c.mutedFg }}
      >
        <ArrowLeftIcon className="size-4" strokeWidth={1.75} />
        Back
      </Link>
    </div>
  );
}
