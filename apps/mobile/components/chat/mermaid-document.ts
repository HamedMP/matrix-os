import { MAX_DIAGRAM_LENGTH, mermaidRenderConfig } from "@matrix-os/ui/chat-diagram-policy";
import { MERMAID_JS } from "./mermaid-bundle";

/** All author text is JSON-encoded and cannot close a script tag. */
export function mermaidDocument(source: string): string | null {
  if (source.length > MAX_DIAGRAM_LENGTH) return null;
  const encoded = JSON.stringify(source).replace(/</g, "\\u003c");
  const library = MERMAID_JS.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-matrix-diagram'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"><style>body{margin:0;padding:8px;background:white}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><script nonce="matrix-diagram">${library}</script><script nonce="matrix-diagram">
    const report = (value) => { if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(value)); };
    mermaid.initialize(${JSON.stringify(mermaidRenderConfig())});
    mermaid.render('matrix-mobile-diagram', ${encoded}).then(({svg}) => {
      const image = document.createElement('img'); image.alt = 'Mermaid diagram';
      image.onload = () => report({height: Math.ceil(image.getBoundingClientRect().height + 16)});
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      document.body.append(image);
    }).catch(() => { document.body.textContent = 'Diagram unavailable.'; report({error: true}); });
  </script></body></html>`;
}
