import { type OnboardingStage, STAGE_TIMEOUTS } from "./types.js";

const VALID_TRANSITIONS: Record<OnboardingStage, OnboardingStage[]> = {
  greeting: ["interview"],
  interview: ["extract_profile"],
  extract_profile: ["suggest_apps"],
  suggest_apps: ["api_key", "done"], // done = claude_code path (skip api_key)
  api_key: ["done"],
  done: [],
};

export interface StateMachineSnapshot {
  current: OnboardingStage;
  completed: OnboardingStage[];
}

interface StateMachineOptions {
  onTimeout?: (stage: OnboardingStage) => void;
}

export function createStateMachine(
  snapshot?: StateMachineSnapshot,
  opts?: StateMachineOptions,
) {
  let current: OnboardingStage = snapshot?.current ?? "greeting";
  let completed: OnboardingStage[] = snapshot?.completed ? [...snapshot.completed] : [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function transition(next: OnboardingStage) {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${current} -> ${next}`);
    }
    completed.push(current);
    current = next;
    clearTimer();
  }

  function startTimer() {
    clearTimer();
    if (current === "done") return;
    const timeout = STAGE_TIMEOUTS[current];
    timer = setTimeout(() => {
      opts?.onTimeout?.(current);
    }, timeout);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function serialize(): StateMachineSnapshot {
    return { current, completed: [...completed] };
  }

  return {
    get current() { return current; },
    get completed() { return [...completed]; },
    transition,
    startTimer,
    clearTimer,
    serialize,
  };
}
