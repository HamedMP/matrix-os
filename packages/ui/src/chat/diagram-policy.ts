export const MAX_DIAGRAM_LENGTH = 30_000;

/** Fresh config per renderer; model-authored directives cannot weaken limits. */
export function mermaidRenderConfig() {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    maxTextSize: MAX_DIAGRAM_LENGTH,
    maxEdges: 500,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: ["secure", "securityLevel", "startOnLoad", "suppressErrorRendering", "maxTextSize", "maxEdges", "htmlLabels", "flowchart", "themeCSS"],
  };
}
