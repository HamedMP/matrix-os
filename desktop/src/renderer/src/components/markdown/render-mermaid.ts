import { MAX_DIAGRAM_LENGTH, mermaidRenderConfig } from "@matrix-os/ui/chat-diagram-policy";
export { MAX_DIAGRAM_LENGTH };

// Keep a single lazy import/configuration. Mermaid serializes renders internally.
let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
function loadRenderer() {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize(mermaidRenderConfig());
    return mermaid;
  }).catch((error: unknown) => {
    renderer = undefined;
    throw error;
  });
  return renderer;
}

export async function renderMermaid(source: string): Promise<string> {
  if (source.length > MAX_DIAGRAM_LENGTH) throw new Error("DiagramTooLarge");
  const mermaid = await loadRenderer();
  const id = `matrix-diagram-${crypto.randomUUID()}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}
