// @vitest-environment jsdom

export type TestViewport = {
  width: number;
  height: number;
};

export const PHONE_VIEWPORT: TestViewport = { width: 390, height: 844 };
export const PHONE_LANDSCAPE_VIEWPORT: TestViewport = { width: 844, height: 390 };
export const DESKTOP_VIEWPORT: TestViewport = { width: 1280, height: 900 };

export function setTestViewport(viewport: TestViewport): void {
  defineWindowNumber("innerWidth", viewport.width);
  defineWindowNumber("outerWidth", viewport.width);
  defineWindowNumber("innerHeight", viewport.height);
  defineWindowNumber("outerHeight", viewport.height);
  window.dispatchEvent(new Event("resize"));
}

export function setPhoneViewport(viewport: TestViewport = PHONE_VIEWPORT): void {
  setTestViewport(viewport);
}

export function setDesktopViewport(): void {
  setTestViewport(DESKTOP_VIEWPORT);
}

export function installViewportMatchMedia(viewport: TestViewport = PHONE_VIEWPORT): () => void {
  const previousMatchMedia = window.matchMedia;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => createMediaQueryList(query, viewport),
  });

  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: previousMatchMedia,
    });
  };
}

function defineWindowNumber(name: "innerWidth" | "outerWidth" | "innerHeight" | "outerHeight", value: number): void {
  Object.defineProperty(window, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function createMediaQueryList(query: string, viewport: TestViewport): MediaQueryList {
  return {
    matches: matchesMediaQuery(query, viewport),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    addListener: () => undefined,
    removeListener: () => undefined,
  };
}

function matchesMediaQuery(query: string, viewport: TestViewport): boolean {
  const minWidth = query.match(/\(min-width:\s*(\d+)px\)/);
  if (minWidth && viewport.width < Number(minWidth[1])) return false;

  const maxWidth = query.match(/\(max-width:\s*(\d+)px\)/);
  if (maxWidth && viewport.width > Number(maxWidth[1])) return false;

  const minHeight = query.match(/\(min-height:\s*(\d+)px\)/);
  if (minHeight && viewport.height < Number(minHeight[1])) return false;

  const maxHeight = query.match(/\(max-height:\s*(\d+)px\)/);
  if (maxHeight && viewport.height > Number(maxHeight[1])) return false;

  if (query.includes("(orientation: portrait)") && viewport.width > viewport.height) return false;
  if (query.includes("(orientation: landscape)") && viewport.width <= viewport.height) return false;

  return true;
}
