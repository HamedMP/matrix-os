/** Install before React mounts so native activation cannot be lost at startup. */
export function createHostedBrowserVisibility(host: Window, page: Document, native: boolean) {
  let active = native ? false : !page.hidden;
  let closed = false;
  let subscriber: ((active: boolean) => void) | undefined;
  const update = (next: boolean) => { if (!closed && active !== next) { active = next; subscriber?.(active); } };
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (event.source !== host || event.origin !== host.location.origin || !data || typeof data !== "object" || Array.isArray(data)) return;
    let count = 0;
    for (const key in data) if (!Object.hasOwn(data, key) || ++count > 2 || !["type", "active"].includes(key)) return;
    const message = data as Record<string, unknown>;
    if (count === 2 && message.type === "matrix-browser-visibility" && typeof message.active === "boolean") update(message.active);
  };
  const onVisibility = () => { if (!native) update(!page.hidden); };
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) update(false);
    else close();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !native) update(!page.hidden);
  };
  const close = () => {
    if (closed) return;
    update(false); closed = true; subscriber = undefined;
    host.removeEventListener("message", onMessage); host.removeEventListener("pagehide", onPageHide);
    host.removeEventListener("pageshow", onPageShow);
    page.removeEventListener("visibilitychange", onVisibility);
  };
  host.addEventListener("message", onMessage); host.addEventListener("pagehide", onPageHide);
  host.addEventListener("pageshow", onPageShow);
  page.addEventListener("visibilitychange", onVisibility);
  return { active: () => active, subscribe(callback: (active: boolean) => void) {
    subscriber = callback;
    return () => { if (subscriber === callback) subscriber = undefined; };
  }, close };
}
