import type { ChatRunContext } from "@matrix-os/contracts";

/** Source locations belong to durable server context, never renderer wire state. */
function publicContext(context: ChatRunContext): ChatRunContext {
  if (!context.agent?.recipe) return context;
  return { ...context, agent: { ...context.agent, recipe: { ...context.agent.recipe,
    skills: context.agent.recipe.skills.map(({ sourceFile: _sourceFile, ...skill }) => skill),
  } } };
}

/** Only validated response envelopes enter here; persisted inputs stay untouched. */
export function projectChatRecipeSources<T>(value: T): T {
  function project(input: unknown, depth: number): unknown {
    if (depth > 4 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(item => project(item, depth + 1));
    const result = { ...input } as Record<string, unknown>;
    if (result.context && typeof result.context === "object") {
      result.context = publicContext(result.context as ChatRunContext);
    }
    // Covers detail, admission, queue, cancellation and SSE content envelopes.
    // Never descend into user message parts, tool output or arbitrary JSON data.
    for (const key of ["record", "items", "content", "run", "runs", "queuedTurn", "queuedTurns"]) {
      if (key in result) result[key] = project(result[key], depth + 1);
    }
    return result;
  }
  return project(value, 0) as T;
}
