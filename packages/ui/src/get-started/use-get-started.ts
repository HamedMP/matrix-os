import {
  GetStartedResponseSchema,
  type GetStartedAnswers,
  getStartedAnswersFromWizard,
  getStartedDraftFromWizard,
  initialGetStartedWizard,
  reduceGetStartedWizard,
  type GetStartedUpdate,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/** How a surface reaches its computer's `/api/settings/get-started`. Responses are validated here. */
export interface GetStartedPort {
  load(signal: AbortSignal): Promise<unknown>;
  save(update: GetStartedUpdate): Promise<unknown>;
}

export type GetStartedPhase = "loading" | "active" | "done";
type SaveResult = { ok: true; value: unknown } | { ok: false };

/** The only failure copy the wizard shows; server and network errors are never displayed. */
export const GET_STARTED_SAVE_ERROR = "We couldn't save your setup. Try again.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export interface GetStartedController {
  phase: GetStartedPhase;
  wizard: GetStartedWizardState | null;
  submitting: boolean;
  error: string | null;
  /** The finished wizard's answers: loaded when already completed, or saved just now. */
  answers: GetStartedAnswers | null;
  /** The owner finished or skipped setup, earlier or just now. */
  ended: boolean;
  dispatch(event: GetStartedWizardEvent): void;
  finish(): void;
  skipAll(): void;
}

export function useGetStarted(port: GetStartedPort): GetStartedController {
  const [phase, setPhase] = useState<GetStartedPhase>("loading");
  const [wizard, setWizard] = useState<GetStartedWizardState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<GetStartedAnswers | null>(null);
  const [ended, setEnded] = useState(false);
  const wizardRef = useRef<GetStartedWizardState | null>(null);
  // Saves run one at a time so a slow draft can never land after completion.
  const saveChain = useRef<Promise<SaveResult> | null>(null);
  // A queued save must not start after the wizard is gone, e.g. once the owner switches computers.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    port.load(controller.signal).then((raw) => {
      if (controller.signal.aborted) return;
      const parsed = GetStartedResponseSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[get-started] unexpected state response");
        setPhase("done");
        return;
      }
      const state = parsed.data;
      if (state.status !== "pending" && state.status !== "in_progress") {
        if (state.status === "completed") setAnswers(state.answers);
        setEnded(state.status === "completed" || state.status === "skipped");
        setPhase("done");
        return;
      }
      const initial = initialGetStartedWizard(state.status === "in_progress" ? state.draft : undefined);
      wizardRef.current = initial;
      setWizard(initial);
      setPhase("active");
    }, (loadError: unknown) => {
      if (controller.signal.aborted) return;
      // Fail closed to today's desktop; the next load tries again.
      console.warn("[get-started] state unavailable:", errorName(loadError));
      setPhase("done");
    });
    return () => controller.abort();
  }, [port]);

  /** Never rejects: failures are logged once here and reported as `ok: false`. */
  const enqueue = useCallback((update: GetStartedUpdate): Promise<SaveResult> => {
    const previous = saveChain.current ?? Promise.resolve<SaveResult>({ ok: true, value: null });
    const next = previous.then(async (): Promise<SaveResult> => {
      if (!mounted.current) return { ok: false };
      return { ok: true, value: await port.save(update) };
    }).then(
      (result) => result,
      (saveError: unknown): SaveResult => {
        console.warn(`[get-started] ${update.type} save failed:`, errorName(saveError));
        return { ok: false };
      },
    );
    saveChain.current = next;
    return next;
  }, [port]);

  const dispatch = useCallback((event: GetStartedWizardEvent) => {
    const current = wizardRef.current;
    if (!current) return;
    const next = reduceGetStartedWizard(current, event);
    wizardRef.current = next;
    setWizard(next);
    setError(null);
    // Drafts are best effort: progress is never blocked on them.
    if (next.step !== current.step) void enqueue({ type: "draft", draft: getStartedDraftFromWizard(next) });
  }, [enqueue]);

  /** Another window may have finished or skipped setup (the save then fails with 409); the saved state decides. */
  const endedElsewhere = useCallback(async (): Promise<boolean> => {
    try {
      const parsed = GetStartedResponseSchema.safeParse(await port.load(new AbortController().signal));
      if (!parsed.success || (parsed.data.status !== "completed" && parsed.data.status !== "skipped")) return false;
      if (parsed.data.status === "completed") setAnswers(parsed.data.answers);
      setEnded(true);
      setPhase("done");
      return true;
    } catch (loadError: unknown) {
      console.warn("[get-started] state recheck failed:", errorName(loadError));
      return false;
    }
  }, [port]);

  const settle = useCallback((update: GetStartedUpdate, expected: "completed" | "skipped") => {
    setSubmitting(true);
    setError(null);
    void enqueue(update).then(async (result) => {
      const parsed = result.ok ? GetStartedResponseSchema.safeParse(result.value) : null;
      if (parsed?.success && parsed.data.status === expected) {
        if (parsed.data.status === "completed") setAnswers(parsed.data.answers);
        setEnded(true);
        setPhase("done");
      } else {
        if (result.ok) console.warn("[get-started] unexpected save response");
        if (!(await endedElsewhere())) setError(GET_STARTED_SAVE_ERROR);
      }
      setSubmitting(false);
    });
  }, [endedElsewhere, enqueue]);

  const finish = useCallback(() => {
    const current = wizardRef.current;
    if (current) settle({ type: "complete", answers: getStartedAnswersFromWizard(current) }, "completed");
  }, [settle]);

  const skipAll = useCallback(() => settle({ type: "skip" }, "skipped"), [settle]);

  return { phase, wizard, submitting, error, answers, ended, dispatch, finish, skipAll };
}
