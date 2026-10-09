import { useMemo } from "react";

import { getAppSlug } from "@/lib/apps";
import { installedAppSlug, useComputerApps } from "@/lib/queries/use-computer-apps";

import { findReplyApps, replyAppCandidates } from "./chat-app-references";
import { ResultCard } from "./ResultCard";
import type { ChatResultApp } from "./types";

interface ReplyResultAppsProps {
  /** The reply's text. */
  text: string;
  /**
   * Whether a path with no root (`apps/notes`) names an app in the home
   * folder. True only for a chat outside any project whose run had no
   * workspace of its own, as on desktop.
   */
  allowRelative: boolean;
  onOpen: (app: ChatResultApp) => void;
}

/** The result cards for the apps a reply refers to. Draws nothing when it refers to none. */
export function ReplyResultApps(props: ReplyResultAppsProps) {
  // The apps catalog is read, and kept fresh, only while a reply on screen
  // names something in the apps folder.
  const mentionsAnApp = useMemo(() => replyAppCandidates(props.text).length > 0, [props.text]);
  return mentionsAnApp ? <CatalogResultApps {...props} /> : null;
}

function CatalogResultApps({ text, allowRelative, onOpen }: ReplyResultAppsProps) {
  const { apps } = useComputerApps();
  const resolved = useMemo(() => {
    const catalog = apps.map((app) => ({
      slug: installedAppSlug(app),
      runtimeSlug: getAppSlug(app),
      path: app.path,
      name: app.name,
      detail: resultAppDetail(app.category),
    }));
    return findReplyApps(text, catalog, { allowRelative });
  }, [apps, text, allowRelative]);

  return resolved.map(({ slug, runtimeSlug, name, detail }) => (
    <ResultCard key={slug} app={{ slug, runtimeSlug, name, detail }} onOpen={onOpen} />
  ));
}

/** "App", followed by the category the catalog files it under when it has one. */
function resultAppDetail(category: string | undefined): string {
  const label = category?.trim();
  return label ? `App · ${label[0]!.toUpperCase()}${label.slice(1)}` : "App";
}
