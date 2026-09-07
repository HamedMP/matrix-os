import { z } from "zod/v4";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export const ShareSnapshotSchema = z.object({
  title: z.string().max(240),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(96_000) }).strict()).max(200),
}).strict();
export type ShareSnapshot = z.infer<typeof ShareSnapshotSchema>;
export const ShareTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function shareHtml(snapshot: ShareSnapshot): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(snapshot.title)} · Shared Chat</title><style>body{font:16px/1.6 system-ui;margin:40px auto;padding:0 24px;max-width:760px;color:#202020;background:#fafafa}article{margin:24px 0}article{overflow-wrap:anywhere}pre{overflow-x:auto;padding:16px;border-radius:12px;background:#eee}code{font:0.88em ui-monospace,monospace}pre code{white-space:pre}table{display:block;overflow-x:auto;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:16px}a{color:#245bb5}h2,h3{line-height:1.3}small{color:#666}</style><main><small>Matrix OS · Read-only snapshot</small><h1>${escape(snapshot.title)}</h1>${snapshot.messages.map((message) => `<article><strong>${message.role === "user" ? "User" : "Assistant"}</strong>${micromark(message.text, { extensions: [gfm(), { disable: { null: ["labelStartImage"] } }], htmlExtensions: [gfmHtml()], allowDangerousHtml: false, allowDangerousProtocol: false })}</article>`).join("")}<small>Shared conversation content may be inaccurate. Attachments and tool output are not included.</small></main></html>`;
}
