/** Reveal an approval without allowing the browser to scroll the surrounding Chat. */
export function revealChatApproval(viewport: HTMLElement | null | undefined, approvalId: string): boolean {
  if (!viewport) return false;
  const anchorId = `tool-approval-${approvalId}`;
  // Resolve inside the owned viewport, including when another Chat has the same
  // request id. Exact attribute comparison also avoids interpreting ids as CSS.
  const target = Array.from(viewport.querySelectorAll<HTMLElement>("[id]"))
    .find(element => element.id === anchorId);
  if (!target) return false;
  const bounds = target.getBoundingClientRect();
  const viewportBounds = viewport.getBoundingClientRect();
  // Canvas windows are transformed by zoom. Rectangles use screen pixels;
  // scrollTop/clientHeight use layout pixels. Normalize before combining them.
  const scaleY = viewport.offsetHeight > 0 && viewportBounds.height > 0
    ? viewportBounds.height / viewport.offsetHeight
    : 1;
  const centeredTop = viewport.scrollTop + (bounds.top - viewportBounds.top) / scaleY - viewport.clientTop
    - (viewport.clientHeight - bounds.height / scaleY) / 2;
  const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTo({ top: Math.min(maximum, Math.max(0, centeredTop)), behavior: "instant" });
  return true;
}
