/** Keep the run-scoped browser visible while Hermes defers other MCP tools. */
export const HERMES_SHARED_BROWSER_TOOL = "mcp__matrix_shared_browser__shared_browser";

export function hermesSharedBrowserToolProjection(): string[] {
  return [
    "import model_tools as matrix_model_tools",
    "matrix_native_definitions = matrix_model_tools.get_tool_definitions",
    "def matrix_browser_definitions(enabled_toolsets=None, disabled_toolsets=None, quiet_mode=False, skip_tool_search_assembly=False):",
    "    if skip_tool_search_assembly:",
    "        return matrix_native_definitions(enabled_toolsets=enabled_toolsets, disabled_toolsets=disabled_toolsets, quiet_mode=quiet_mode, skip_tool_search_assembly=True)",
    // Both observations use native selection/availability/sanitization. Raw first leaves native cache hints on the assembled view.
    "    raw = matrix_native_definitions(enabled_toolsets=enabled_toolsets, disabled_toolsets=disabled_toolsets, quiet_mode=quiet_mode, skip_tool_search_assembly=True)",
    "    assembled = matrix_native_definitions(enabled_toolsets=enabled_toolsets, disabled_toolsets=disabled_toolsets, quiet_mode=quiet_mode, skip_tool_search_assembly=False)",
    "    if not isinstance(raw, list) or not isinstance(assembled, list) or len(raw) > 1024 or len(assembled) > 1024: raise RuntimeError('Browser tool unavailable')",
    `    name = ${JSON.stringify(HERMES_SHARED_BROWSER_TOOL)}`,
    "    def matches(values):",
    "        return [item for item in values if isinstance(item, dict) and isinstance(item.get('function'), dict) and item['function'].get('name') == name]",
    "    candidates, visible = matches(raw), matches(assembled)",
    "    if len(candidates) > 1 or len(visible) > 1: raise RuntimeError('Browser tool unavailable')",
    "    if not candidates:",
    "        if visible: raise RuntimeError('Browser tool unavailable')",
    "        return assembled",
    "    if visible:",
    "        if visible[0] != candidates[0]: raise RuntimeError('Browser tool unavailable')",
    "        return assembled",
    // Never mutate native cached lists/schemas or expose any other deferred tool.
    "    return list(assembled) + [copy.deepcopy(candidates[0])]",
    "matrix_model_tools.get_tool_definitions = matrix_browser_definitions",
  ];
}
