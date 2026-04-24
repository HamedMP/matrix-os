"use client";

import type { ContentDisplay as ContentDisplayType } from "@/hooks/useOnboarding";
import { AppSuggestionCards } from "./AppSuggestionCards";
import { DesktopMockup } from "./DesktopMockup";
import { ProfileInfoPanel } from "./ProfileInfoPanel";

interface ContentDisplayProps {
  content: ContentDisplayType;
}

export function ContentDisplay({ content }: ContentDisplayProps) {
  return (
    <div className="absolute inset-x-0 top-[8%] bottom-[38%] flex items-center justify-center px-8">
      <div
        className="transition-opacity duration-700 ease-in-out w-full flex justify-center"
        style={{ opacity: content ? 1 : 0 }}
      >
        {content?.kind === "app_suggestions" && (
          <AppSuggestionCards apps={content.apps} />
        )}
        {content?.kind === "desktop_mockup" && (
          <DesktopMockup highlights={content.highlights} />
        )}
        {content?.kind === "profile_info" && (
          <ProfileInfoPanel fields={content.fields} />
        )}
      </div>
    </div>
  );
}
