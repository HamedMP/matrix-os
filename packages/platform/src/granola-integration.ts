export const GRANOLA_PRESET = {
  id: "granola",
  name: "Granola",
  url: "https://mcp.granola.ai/mcp",
  tools: [
    "query_granola_meetings",
    "list_meeting_folders",
    "list_meetings",
    "get_meetings",
    "get_meeting_transcript",
    "get_account_info",
  ] as const,
  // These two tools are available on every Granola plan. The remaining tools
  // stay allowlisted when discovered, but activation does not fail when a
  // user's plan or workspace policy omits an optional capability.
  requiredTools: ["list_meetings", "get_meetings"] as const,
} as const;

interface DiscoveredGranolaTool {
  name: string;
  inputSchema?: unknown;
}

interface GranolaToolCall {
  toolName: typeof GRANOLA_PRESET.tools[number];
  arguments: Record<string, unknown>;
}

export interface GranolaActionPlan {
  calls: GranolaToolCall[];
  combine: boolean;
}

function schemaProperties(
  toolName: string,
  tools: DiscoveredGranolaTool[],
): Record<string, unknown> | undefined {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool?.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    return undefined;
  }
  const properties = (tool.inputSchema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : undefined;
}

function mappedArgument(
  toolName: string,
  fieldName: string,
  value: unknown,
  aliases: readonly string[],
  tools: DiscoveredGranolaTool[],
): Record<string, unknown> {
  const properties = schemaProperties(toolName, tools);
  const key = aliases.find((candidate) => properties?.[candidate]);
  if (!key) {
    throw new Error(`Granola ${toolName} schema has no supported ${fieldName}`);
  }
  return { [key]: value };
}

function noteIdArguments(
  toolName: "get_meetings" | "get_meeting_transcript",
  noteId: string,
  tools: DiscoveredGranolaTool[],
): Record<string, unknown> {
  const properties = schemaProperties(toolName, tools);
  const single = ["meeting_id", "meetingId", "id"].find((key) => properties?.[key]);
  if (single) return { [single]: noteId };
  const plural = ["meeting_ids", "meetingIds", "ids"].find((key) => properties?.[key]);
  if (plural) return { [plural]: [noteId] };
  throw new Error(`Granola ${toolName} schema has no supported meeting identifier`);
}

function boundedString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`Granola ${fieldName} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new Error(`Granola ${fieldName} is invalid`);
  }
  return normalized;
}

function boundedLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Granola limit is invalid");
  }
  return Math.min(Math.floor(value), 100);
}

function listArguments(
  params: Record<string, unknown>,
  tools: DiscoveredGranolaTool[],
): Record<string, unknown> {
  const mappings = [
    ["folderId", ["folder_id", "folderId"], (value: unknown) => boundedString(value, "folderId", 512)],
    ["timeRange", ["time_range", "timeRange"], (value: unknown) => boundedString(value, "timeRange", 100)],
    ["limit", ["limit", "page_size", "pageSize", "max_results", "maxResults"], boundedLimit],
  ] as const;
  return Object.fromEntries(mappings.flatMap(([field, aliases, normalize]) => {
    const value = params[field];
    if (value === undefined) return [];
    return Object.entries(mappedArgument("list_meetings", field, normalize(value), aliases, tools));
  }));
}

export function planGranolaAction(
  actionId: string,
  params: Record<string, unknown> | undefined,
  tools: DiscoveredGranolaTool[],
): GranolaActionPlan {
  const input = params ?? {};
  if (actionId === "search_notes") {
    const query = boundedString(input.query, "query", 4_000);
    return {
      calls: [{
        toolName: "query_granola_meetings",
        arguments: mappedArgument(
          "query_granola_meetings",
          "query field",
          query,
          ["query", "question", "prompt", "search_query", "searchQuery"],
          tools,
        ),
      }],
      combine: false,
    };
  }
  if (actionId === "list_folders") {
    return {
      calls: [{ toolName: "list_meeting_folders", arguments: {} }],
      combine: false,
    };
  }
  if (actionId === "list_notes") {
    return {
      calls: [{ toolName: "list_meetings", arguments: listArguments(input, tools) }],
      combine: false,
    };
  }
  if (actionId === "get_account") {
    return {
      calls: [{ toolName: "get_account_info", arguments: {} }],
      combine: false,
    };
  }
  if (actionId !== "get_note") {
    throw new Error("Unknown Granola action");
  }
  const noteId = boundedString(input.noteId, "noteId", 512);
  const calls: GranolaToolCall[] = [{
    toolName: "get_meetings",
    arguments: noteIdArguments("get_meetings", noteId, tools),
  }];
  if (input.includeTranscript === true) {
    calls.push({
      toolName: "get_meeting_transcript",
      arguments: noteIdArguments("get_meeting_transcript", noteId, tools),
    });
  }
  return { calls, combine: calls.length === 2 };
}
