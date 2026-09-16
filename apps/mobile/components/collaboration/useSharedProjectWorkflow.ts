import {
  CollaborationProjectSchema,
  CollaborationScopeSchema,
  type CollaborationProject,
} from "@matrix-os/contracts/collaboration";
import { useCallback, useRef } from "react";
import type { z } from "zod/v4";
import {
  fetchCollaborationScope,
  fetchSharedProject,
} from "@/lib/requests/collaboration";

type CollaborationScope = z.infer<typeof CollaborationScopeSchema>;
type MutableValue<T> = { current: T };
type ProjectPatch = {
  loading?: boolean;
  error?: string;
  scope?: CollaborationScope | null;
  project?: CollaborationProject | null;
};
type ProjectDispatch = (action: { type: "patch"; patch: ProjectPatch }) => void;

export class CollaborationRecoverySupersededError extends Error {
  constructor() {
    super("Collaboration recovery was superseded");
    this.name = "CollaborationRecoverySupersededError";
  }
}

export function useSharedProjectWorkflow({
  token,
  dispatch,
  eventScopeRef,
  eventSequenceRef,
}: {
  token: () => Promise<string>;
  dispatch: ProjectDispatch;
  eventScopeRef: MutableValue<string | null>;
  eventSequenceRef: MutableValue<string>;
}) {
  const loadGeneration = useRef(0);

  const loadProject = useCallback(async (scopeId: string) => {
    const generation = ++loadGeneration.current;
    if (eventScopeRef.current !== scopeId) {
      eventScopeRef.current = scopeId;
      eventSequenceRef.current = "0";
    }
    dispatch({ type: "patch", patch: {
      loading: true,
      error: "",
      scope: null,
      project: null,
    } });
    try {
      const actorToken = await token();
      const [nextScope, nextProject] = await Promise.all([
        fetchCollaborationScope(actorToken, scopeId),
        fetchSharedProject(actorToken, scopeId),
      ]);
      const project = CollaborationProjectSchema.parse(nextProject);
      if (nextScope.kind !== "project" || project.scopeId !== nextScope.id || project.id !== nextScope.resourceId) {
        throw new Error("Project scope mismatch");
      }
      if (generation === loadGeneration.current) {
        dispatch({ type: "patch", patch: { scope: CollaborationScopeSchema.parse(nextScope), project } });
      }
    } catch (failure: unknown) {
      if (generation !== loadGeneration.current) return;
      console.warn("[mobile-collaboration] project load failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "This shared project is unavailable. Your access may have changed." } });
    } finally {
      if (generation === loadGeneration.current) dispatch({ type: "patch", patch: { loading: false } });
    }
  }, [dispatch, eventScopeRef, eventSequenceRef, token]);

  const refreshLiveProject = useCallback(async (scopeId: string) => {
    const generation = ++loadGeneration.current;
    const actorToken = await token();
    const [nextScope, nextProject] = await Promise.all([
      fetchCollaborationScope(actorToken, scopeId),
      fetchSharedProject(actorToken, scopeId),
    ]);
    const project = CollaborationProjectSchema.parse(nextProject);
    if (nextScope.kind !== "project" || project.scopeId !== nextScope.id || project.id !== nextScope.resourceId) {
      throw new Error("Project scope mismatch");
    }
    if (generation !== loadGeneration.current || eventScopeRef.current !== scopeId) {
      throw new CollaborationRecoverySupersededError();
    }
    dispatch({ type: "patch", patch: {
      scope: CollaborationScopeSchema.parse(nextScope),
      project,
      loading: false,
      error: "",
    } });
  }, [dispatch, eventScopeRef, token]);

  const markUnavailable = useCallback(() => {
    loadGeneration.current += 1;
    dispatch({ type: "patch", patch: {
      scope: null,
      project: null,
      loading: false,
      error: "This shared project is unavailable. Your access may have changed.",
    } });
  }, [dispatch]);

  const invalidateProject = useCallback(() => {
    loadGeneration.current += 1;
    eventScopeRef.current = null;
  }, [eventScopeRef]);

  return { invalidateProject, loadProject, markUnavailable, refreshLiveProject };
}
