"use client";

import { mcpTokens as t } from "./mcp-settings-tokens.js";

export type McpCustomAuthMode = "none" | "oauth" | "bearer" | "api_key";

export interface McpCustomServerFormProps {
  name: string;
  url: string;
  authMode: McpCustomAuthMode;
  credential: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onAuthModeChange: (value: McpCustomAuthMode) => void;
  onCredentialChange: (value: string) => void;
  /** True while the add button may be pressed (surface owns busy/validation state). */
  canSubmit: boolean;
  onSubmit: () => void;
}

const field = "h-9 w-full rounded-lg border px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-current";

/** "Add a custom MCP server" card, presentational only; each surface owns the request. */
export function McpCustomServerForm(props: McpCustomServerFormProps) {
  const { name, url, authMode, credential, canSubmit } = props;
  const needsCredential = authMode === "bearer" || authMode === "api_key";
  const fieldStyle = { borderColor: t.borderStrong, background: "var(--bg-app, var(--background))", color: t.text };
  return (
    <section aria-label="Add a custom MCP server" className="space-y-4 rounded-2xl border p-5" style={{ borderColor: t.border, background: t.surface }}>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold" style={{ color: t.text }}>Paste any MCP server URL</p>
        <p className="text-xs" style={{ color: t.muted }}>Not in the list? Add any remote HTTPS MCP server. It joins your Matrix MCP like the others.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
        <label className="space-y-1.5 text-xs font-medium sm:col-span-3" style={{ color: t.secondary }}>
          <span>Name</span>
          <input aria-label="MCP server name" value={name} onChange={event => props.onNameChange(event.target.value)} placeholder="Research tools" maxLength={100} className={field} style={fieldStyle} />
        </label>
        <label className="space-y-1.5 text-xs font-medium sm:col-span-5" style={{ color: t.secondary }}>
          <span>Server URL</span>
          <input aria-label="MCP server URL" value={url} onChange={event => props.onUrlChange(event.target.value)} placeholder="https://example.com/mcp" maxLength={2048} className={field} style={{ ...fieldStyle, fontFamily: t.mono }} />
        </label>
        <label className="space-y-1.5 text-xs font-medium sm:col-span-2" style={{ color: t.secondary }}>
          <span>Sign-in</span>
          <select aria-label="Authentication mode" value={authMode} onChange={event => props.onAuthModeChange(event.target.value as McpCustomAuthMode)} className={field} style={fieldStyle}>
            <option value="oauth">MCP OAuth</option>
            <option value="none">No authentication</option>
            <option value="bearer">Bearer token</option>
            <option value="api_key">X-API-Key</option>
          </select>
        </label>
        <div className="flex items-end sm:col-span-2">
          <button type="button" disabled={!canSubmit} onClick={props.onSubmit}
            className="h-9 w-full whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: t.primary, color: t.primaryFg }}>
            Add MCP server
          </button>
        </div>
        {needsCredential ? (
          <label className="space-y-1.5 text-xs font-medium sm:col-span-12" style={{ color: t.secondary }}>
            <span>Secret</span>
            <input aria-label="MCP credential" type="password" autoComplete="off" value={credential} onChange={event => props.onCredentialChange(event.target.value)} placeholder="Secret credential" maxLength={4096} className={field} style={fieldStyle} />
          </label>
        ) : null}
      </div>
    </section>
  );
}
