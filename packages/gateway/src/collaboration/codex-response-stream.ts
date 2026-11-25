/** Validate a bounded Responses SSE body before supplying a missing MIME header.
 * Only the pinned ChatGPT Codex endpoint may use this compatibility path.
 */
export function isCompleteCodexResponseStream(body: string): boolean {
  let terminal = false;
  for (const block of body.replaceAll("\r\n", "\n").split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:") && event === undefined) {
        event = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      } else return false;
    }
    if (!data.length) continue;
    const frame = data.join("\n");
    if (frame === "[DONE]") {
      if (!terminal) return false;
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(frame); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return false;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string" || !/^[a-z][a-z0-9_.]{0,127}$/.test(type)
      || event !== undefined && event !== type) return false;
    if (["response.completed", "response.failed", "response.incomplete"].includes(type)) terminal = true;
  }
  return terminal;
}
