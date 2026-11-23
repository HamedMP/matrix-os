/// <reference types="vite/client" />
/**
 * Loads the review modules (`../review` for the controller, `./review` for
 * its components, both owned elsewhere) when they are part of the build,
 * and keeps one review controller per session for the open document.
 * Without them `useReviewController` stays null and the shell shows fallbacks.
 */

import { type ComponentType, useEffect, useState } from "react";
import type { DocumentEditorController } from "../editor/index";
import type { DocumentSession } from "../session/index";

type Loader = () => Promise<Record<string, unknown>>;

const UI_LOADER: Loader | undefined = Object.values(import.meta.glob<Record<string, unknown>>("./review/index.ts"))[0];
const LOGIC_LOADER: Loader | undefined = Object.values(import.meta.glob<Record<string, unknown>>("../review/index.ts"))[0];

/** True when the build contains the review modules. */
export const REVIEW_AVAILABLE = UI_LOADER !== undefined && LOGIC_LOADER !== undefined;

/** The controller as the shell sees it; everything else about it stays with the review module. */
export interface ReviewControllerHandle {
  attachEditor(editor: DocumentEditorController | null): void;
  dispose(): void;
}

export interface ReviewModules {
  ReviewController: new (session: DocumentSession) => ReviewControllerHandle;
  useReviewShortcuts(controller: ReviewControllerHandle | null): void;
  useCommentClicks(controller: ReviewControllerHandle | null, container: HTMLElement | null): void;
  RevisionHoverCard: ComponentType<{ controller: ReviewControllerHandle; container: HTMLElement | null; disabled?: boolean }>;
  ReviewPanel: ComponentType<{ controller: ReviewControllerHandle; busy?: boolean }>;
  CommentsPanel: ComponentType<{ controller: ReviewControllerHandle; busy?: boolean }>;
}

const UI_NAMES = ["useReviewShortcuts", "useCommentClicks", "RevisionHoverCard", "ReviewPanel", "CommentsPanel"];

let loading: Promise<ReviewModules | null> | null = null;

/** Loads both modules once. Null when they are absent, fail to load, or lack what the shell needs. */
export function loadReviewModules(): Promise<ReviewModules | null> {
  if (UI_LOADER === undefined || LOGIC_LOADER === undefined) return Promise.resolve(null);
  loading ??= Promise.all([UI_LOADER(), LOGIC_LOADER()]).then(
    ([ui, logic]) => {
      if (typeof logic.ReviewController !== "function" || UI_NAMES.some((name) => ui[name] === undefined)) {
        console.warn("docs: the review modules do not export what the shell needs");
        return null;
      }
      return { ...(ui as unknown as Omit<ReviewModules, "ReviewController">), ReviewController: logic.ReviewController as ReviewModules["ReviewController"] };
    },
    (error: unknown) => {
      console.warn("docs: could not load the review modules", error);
      loading = null;
      return null;
    },
  );
  return loading;
}

/** A review controller for the session, connected to the editor; null until the modules are loaded or without them. */
export function useReviewController(session: DocumentSession, editor: DocumentEditorController | null): ReviewControllerHandle | null {
  const [controller, setController] = useState<ReviewControllerHandle | null>(null);
  useEffect(() => {
    let live = true;
    let created: ReviewControllerHandle | null = null;
    void loadReviewModules().then((modules) => {
      if (!live || modules === null) return;
      try {
        created = new modules.ReviewController(session);
        setController(created);
      } catch (error) {
        console.warn("docs: could not start the review controller", error);
      }
    });
    return () => {
      live = false;
      created?.dispose();
      setController(null);
    };
  }, [session]);
  useEffect(() => {
    if (controller === null) return undefined;
    controller.attachEditor(editor);
    return () => controller.attachEditor(null);
  }, [controller, editor]);
  return controller;
}
