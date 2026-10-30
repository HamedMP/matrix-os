"use client";

import { onboardingChecklist } from "@matrix-os/brand";
import { useEffect, useState } from "react";
import { DownloadIcon } from "@/lib/hugeicons";
import { DESKTOP_APP_DOWNLOAD_URL, resolveDesktopDownloadSuggestion, type DesktopDownloadSuggestion } from "./desktop-download-url";

const BRAND_COLORS = onboardingChecklist.colors;

/** The detected desktop download for this browser, refined once the CPU architecture is known. */
export function useDesktopDownloadSuggestion(): DesktopDownloadSuggestion {
  const [downloadSuggestion, setDownloadSuggestion] = useState<DesktopDownloadSuggestion>({
    href: DESKTOP_APP_DOWNLOAD_URL,
    label: "Choose desktop download",
  });
  useEffect(() => {
    setDownloadSuggestion(resolveDesktopDownloadSuggestion(navigator));

    const userAgentData = (navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
      };
    }).userAgentData;
    if (!userAgentData?.getHighEntropyValues) return;

    let cancelled = false;
    void userAgentData.getHighEntropyValues(["architecture"]).then(({ architecture }) => {
      if (!cancelled) {
        setDownloadSuggestion(resolveDesktopDownloadSuggestion(navigator, architecture));
      }
    }).catch((error: unknown) => {
      console.warn(
        "[getting-started] unable to detect device architecture:",
        error instanceof Error ? error.name : typeof error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return downloadSuggestion;
}

export function DesktopDownloadLink({ suggestion, onClick }: { suggestion: DesktopDownloadSuggestion; onClick?(): void }) {
  return (
    <a
      href={suggestion.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={suggestion.label}
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
      style={{ color: BRAND_COLORS.text, fontSize: 11 }}
    >
      <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block">{suggestion.label}</span>
        {suggestion.guidance ? (
          <span className="mt-1 block leading-snug" style={{ color: BRAND_COLORS.subtleText, fontSize: 10 }}>
            {suggestion.guidance}
          </span>
        ) : null}
      </span>
    </a>
  );
}
