/**
 * Wires the review and assistant modules to the shell's panel props. The
 * modules are passed in after a lazy import, so nothing here imports them
 * directly and a build without them still works.
 */
import { lazy, useEffect, useMemo, type ComponentType } from "react";
import type { SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import { logFailure } from "./bridge";
import type { SheetPanelProps } from "./panel-slots";

export type PanelModule = Record<string, unknown>;
type Loaders = Record<string, () => Promise<PanelModule>>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * A lazy component built from the first module of each loader set, or
 * `fallback` when a set is empty, loading fails or `build` returns null.
 */
export function lazyFromModules(
  name: string,
  loaders: readonly Loaders[],
  build: (modules: PanelModule[]) => ComponentType<SheetPanelProps> | null,
  fallback: ComponentType<SheetPanelProps>,
): ComponentType<SheetPanelProps> {
  const picked = loaders.map((set) => Object.values(set)[0]);
  if (picked.some((loader) => loader === undefined)) return fallback;
  return lazy(async () => {
    try {
      const modules = await Promise.all(picked.map((loader) => (loader as () => Promise<PanelModule>)()));
      return { default: build(modules) ?? fallback };
    } catch (error: unknown) {
      console.warn(`[sheets] panel.load.failed (${name}, ${errorName(error)})`);
      return { default: fallback };
    }
  });
}

// ---------------------------------------------------------------- review

interface ReviewControllerLike {
  goTo(id: string): void;
  dispose(): void;
}
type ReviewControllerClass = new (session: SheetSession, grid: SheetGridController, log: (message: string, error: unknown) => void) => ReviewControllerLike;
type ReviewPanelComponent = ComponentType<{ review: ReviewControllerLike; onClose?: () => void }>;

/** `[ui/review module, review module]` to the review panel over a controller made per session and grid. */
export function buildReviewPanel([view, core]: PanelModule[]): ComponentType<SheetPanelProps> | null {
  const Panel = view?.SheetReviewPanel as ReviewPanelComponent | undefined;
  const Controller = core?.SheetReviewController as ReviewControllerClass | undefined;
  if (typeof Panel !== "function" || typeof Controller !== "function") return null;
  return function ReviewAdapter({ session, controller: grid, onClose, focusChangeId }: SheetPanelProps) {
    const review = useMemo(() => new Controller(session, grid, logFailure), [session, grid]);
    useEffect(() => () => review.dispose(), [review]);
    useEffect(() => {
      if (focusChangeId) review.goTo(focusChangeId);
    }, [review, focusChangeId]);
    return <Panel review={review} onClose={onClose} />;
  };
}

// ---------------------------------------------------------------- assistant

interface AssistantLike {
  dispose(): void;
}
type AssistantClass = new (deps: {
  session: SheetSession;
  ai: unknown;
  grid: SheetGridController;
  log: (message: string, error: unknown) => void;
  onReview: (proposalId: string, firstChangeId: string | null) => void;
}) => AssistantLike;
type AgentPanelComponent = ComponentType<{
  assistant: AssistantLike;
  getSelection: () => unknown;
  beforeAction?: () => void;
  onClose?: () => void;
  aiAvailable?: boolean;
}>;

/** `[ui/agent module, agent module]` to the assistant panel over an assistant made per session and grid. */
export function buildAgentPanel([view, core]: PanelModule[]): ComponentType<SheetPanelProps> | null {
  const Panel = view?.SheetsAgentPanel as AgentPanelComponent | undefined;
  const selectionFromGrid = view?.selectionFromGrid as ((grid: SheetGridController) => unknown) | undefined;
  const Assistant = core?.SheetsAssistant as AssistantClass | undefined;
  const bridgeAi = core?.bridgeSheetsAi as (() => unknown) | undefined;
  if (typeof Panel !== "function" || typeof Assistant !== "function" || typeof selectionFromGrid !== "function" || typeof bridgeAi !== "function") return null;
  return function AgentAdapter({ session, controller: grid, onClose, onOpenReview }: SheetPanelProps) {
    const ai = useMemo(() => bridgeAi(), []);
    const assistant = useMemo(
      () => new Assistant({ session, ai, grid, log: logFailure, onReview: (_proposalId, changeId) => onOpenReview?.(changeId) }),
      [session, ai, grid, onOpenReview],
    );
    useEffect(() => () => assistant.dispose(), [assistant]);
    return <Panel assistant={assistant} getSelection={() => selectionFromGrid(grid)} beforeAction={() => grid.commitEdit()} onClose={onClose} aiAvailable={ai !== null} />;
  };
}
