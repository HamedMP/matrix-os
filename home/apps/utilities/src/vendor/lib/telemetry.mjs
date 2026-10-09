import { getTool, tools } from "./catalog.mjs";

const actions = new Set(["open", "card_click", "start", "success", "error", "copy", "download", "related_click", "matrix_click"]);
const categories = new Set(["All", ...tools.map((tool) => tool.category)]);
const eventNames = new Set([...actions].map((action) => `free_tool_${action}`));
eventNames.add("free_tool_category_select");
eventNames.add("free_tool_search");

function bucket(value, ranges) {
  for (const [limit, label] of ranges) if (value <= limit) return label;
  return ranges.at(-1)[1];
}

/** Directory metrics intentionally omit the search phrase. */
export function directoryEvent(action, { category, queryLength, resultCount } = {}) {
  if (!categories.has(category)) throw new Error("Unknown category.");
  if (action === "category_select") {
    return { name: "free_tool_category_select", properties: { tool_slug: "hub", tool_category: category } };
  }
  if (action !== "search" || !Number.isInteger(queryLength) || queryLength < 0 || !Number.isInteger(resultCount) || resultCount < 0 || resultCount > tools.length) {
    throw new Error("Invalid search event.");
  }
  return { name: "free_tool_search", properties: {
    tool_slug: "hub",
    tool_category: category,
    query_length_bucket: bucket(queryLength, [[0, "0"], [3, "1-3"], [10, "4-10"], [Number.MAX_SAFE_INTEGER, "11+"]]),
    result_count_bucket: bucket(resultCount, [[0, "0"], [10, "1-10"], [50, "11-50"], [Number.MAX_SAFE_INTEGER, "51+"]]),
  } };
}

/** Produces analytics properties from a fixed catalog. Never pass input or output. */
export function toolEvent(slug, action, error, targetSlug) {
  const tool = getTool(slug);
  if (!tool && slug !== "hub") throw new Error("Unknown tool.");
  if (!actions.has(action)) throw new Error("Unknown tool action.");
  const properties = { tool_slug: slug, tool_category: tool?.category ?? "All" };
  if (action === "related_click") {
    if (!getTool(targetSlug)) throw new Error("Unknown related tool.");
    properties.target_slug = targetSlug;
  }
  if (action === "error") {
    const message = error instanceof Error ? error.message : "";
    properties.error_class = /too (large|long)|100,000|limited to|no more than/.test(message) ? "size" : /timeout|took too long/.test(message) ? "timeout" : /worker|support/.test(message) ? "unsupported" : "validation";
  }
  return { name: `free_tool_${action}`, properties };
}

/** Mounting an example emits nothing; intentional live-counter usage emits once. */
export function createCounterSession(slug, capture) {
  let recorded = false;
  return () => {
    if (recorded || (slug !== "word-counter" && slug !== "character-counter")) return;
    recorded = true;
    capture(toolEvent(slug, "start"));
    capture(toolEvent(slug, "success"));
  };
}

export function isToolRoute(pathname) {
  return /^\/tools(?:\/|$)/.test(pathname ?? "");
}

/** Last line of defense before the SDK sends events from sensitive tool routes. */
export function filterToolCapture(capture, pathname, origin = "https://matrix-os.com") {
  if (!capture) return capture;
  const source = capture.properties ?? {};
  let pagePath = null;
  if (typeof source.$current_url === "string") {
    try { pagePath = new URL(source.$current_url).pathname; } catch { /* invalid URL: fail closed below */ }
  }
  if (capture.event === "$pageview" && isToolRoute(pagePath)) {
    if (pagePath !== "/tools" && !getTool(pagePath.slice("/tools/".length))) return null;
    return { ...capture, properties: {
      token: source.token,
      distinct_id: source.distinct_id,
      $session_id: source.$session_id,
      $current_url: `${origin}${pagePath}`,
      $pathname: pagePath,
    }, $set: undefined, $set_once: undefined, $unset: undefined };
  }
  // PostHog can flush an event after SPA navigation has already left the tool.
  // Honor the event's originating URL as well as the current route.
  if (!isToolRoute(pathname) && !isToolRoute(pagePath)) return capture;
  if (!eventNames.has(capture.event)) return null;
  const slug = source.tool_slug;
  const tool = getTool(slug);
  if (!tool && slug !== "hub") return null;
  const category = source.tool_category;
  if (category !== (tool?.category ?? (categories.has(category) ? category : null))) return null;
  const properties = {
    token: source.token,
    distinct_id: source.distinct_id,
    tool_slug: slug,
    tool_category: category,
  };
  if (typeof source.$session_id === "string") properties.$session_id = source.$session_id;
  if (capture.event === "free_tool_error") {
    if (!["size", "timeout", "unsupported", "validation"].includes(source.error_class)) return null;
    properties.error_class = source.error_class;
  }
  if (capture.event === "free_tool_related_click") {
    if (!getTool(source.target_slug)) return null;
    properties.target_slug = source.target_slug;
  }
  if (capture.event === "free_tool_search") {
    if (slug !== "hub" || !["0", "1-3", "4-10", "11+"].includes(source.query_length_bucket) || !["0", "1-10", "11-50", "51+"].includes(source.result_count_bucket)) return null;
    properties.query_length_bucket = source.query_length_bucket;
    properties.result_count_bucket = source.result_count_bucket;
  }
  if (capture.event === "free_tool_category_select" && slug !== "hub") return null;
  return { ...capture, properties, $set: undefined, $set_once: undefined, $unset: undefined };
}
