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
  const centeredTop = viewport.scrollTop + bounds.top - viewportBounds.top - viewport.clientTop
    - (viewport.clientHeight - bounds.height) / 2;
  const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTo({ top: Math.min(maximum, Math.max(0, centeredTop)), behavior: "instant" });
  return true;
}
