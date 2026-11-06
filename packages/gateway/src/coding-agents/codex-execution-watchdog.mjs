// Monitor individual execution requests, never the lifetime or silence of a busy turn.
// Runs in the persistent Node runner, not the short-lived HTTP dispatch.
const HOUR = 60 * 60_000;
function budget(env, key, fallback) {
  if (env[key] === undefined) return fallback;
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * HOUR) {
    throw new Error("Invalid execution budget");
  }
  return value;
}

export function createCodexExecutionWatchdog({ expire, waitingForHuman, env = process.env }) {
  const toolDeadline = budget(env, "MATRIX_CODEX_TOOL_DEADLINE_MS", 10 * 60_000);
  const commandDeadline = budget(env, "MATRIX_CODEX_COMMAND_DEADLINE_MS", 8 * HOUR);
  const idleDeadline = budget(env, "MATRIX_CODEX_NO_PROGRESS_MS", 30 * 60_000);
  // Capacity matches the owning runner. Active tools are never silently evicted.
  const tools = new Map();
  let timer;
  let active = false;
  let lastTick = 0;

  function stop() {
    active = false;
    clearInterval(timer);
    tools.clear();
  }

  function advance() {
    if (!active) return false;
    const now = performance.now();
    const delta = Math.max(0, now - lastTick);
    lastTick = now;
    // Approval/input has its own expiry policy. It is neither execution nor
    // progress; exclude that time instead of silently refreshing tool budgets.
    if (waitingForHuman()) return false;
    for (const tool of tools.values()) {
      tool.elapsed += delta;
      tool.idle += delta;
    }
    return true;
  }

  function tick() {
    if (!advance()) return;
    let failure;
    for (const [toolCallId, tool] of tools) {
      if (tool.elapsed >= tool.deadline || tool.idle >= idleDeadline) {
        failure = { phase: tool.elapsed >= tool.deadline ? "tool_deadline" : "tool_no_progress", toolCallId, durationMs: Math.round(tool.elapsed) };
        break;
      }
    }
    if (failure) {
      stop();
      expire(failure);
    }
  }

  return {
    start() {
      stop();
      active = true;
      lastTick = performance.now();
      timer = setInterval(tick, Math.min(1000, toolDeadline, commandDeadline, idleDeadline));
      timer.unref?.();
    },
    stop,
    toolStarted(id, kind) {
      if (!active || tools.has(id)) return;
      advance();
      if (tools.size >= 500) throw new Error("Execution tracking capacity exceeded");
      tools.set(id, { elapsed: 0, idle: 0,
        deadline: kind === "commandExecution" || kind === "collabAgentToolCall" ? commandDeadline : toolDeadline });
    },
    toolCompleted(id) {
      advance();
      tools.delete(id);
    },
    progress(id) {
      if (!active) return;
      advance();
      if (id && tools.has(id)) tools.get(id).idle = 0;
    },
  };
}
